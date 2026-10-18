import { toDeviceMotion } from './device-motion.ts';
import { deploymentStatus } from './deployment.ts';
import { behaviorMode, manualTarget, coarseTarget, followFresh, FOLLOW_MAX_AGE_MS, type FollowGate } from './follow-person.ts';
import { APIDebugCache, type APIDebug } from './api-debug.ts';
import { parseRawFrame, encodeRawFrame, LatestFrames, RAW_PACKET_BYTES, RAW_MAX_AGE_MS, deviceSession, type RawFrame } from './raw-frame';
import { FrameWindow } from './frame-window';
import { monitorHTML, monitorJS } from './monitor';
import { logCloseRequested, logConnection, logRun, logTransport } from './observability';
import { serializeServer, parseClientMessage, isHeadCommand, type HeadResponse, finite, uint, type ServerData, type DeviceStatus, type TelemetrySummary, type TelemetrySnapshot } from './protocol.ts';
import { paidSession, reservePaidCall, guardedFetch, controlledBudget, updatePaidSession, type BudgetStatus, type ControlledPaidEnv } from './paid-session';
import { newHistory, newTransport, recordRun, receiveFrame, addSample, pacing, snapshot, type History, type Transport, type Pipeline, type Stage } from './telemetry';
import { initialHumanActions, scanHumanActions, consumeHumanAction, type HumanActionState } from './human-actions';
import { choosePersonality, initialEmotion, personalities, isPersonality } from './personality';
import { callDecisions, callNarration, summarizeCalls, OpenAIError, DECISIONS_MODEL, type APITiming, type CallMetrics } from './openai';
import { narrationPayload, needsNarration, fallbackNarration, mockNarration } from './narration';
import { initialMind, planFor, socialContext, mockChoice, type Mind, type Behavior, type Dialogue, type PublicPeer, type Motion, type Personality } from './social';
import { evaluationPayload, parseEvaluation, mockEvaluation, projectExperiences, emotionKeys, type Emotion, type Experience, type Affect } from './perception';
interface Env extends ControlledPaidEnv {
  ROOMS: DurableObjectNamespace; ASSETS?: Fetcher; ROOM_CONFIG?: string; SESSION_SECRET?: string;
  ALLOWED_ORIGIN?: string; ENABLE_LAB?: string; AI_MODE?: string; OPENAI_API_KEY?: string; RGB565_BIG_ENDIAN_DEVICES?: string; BEHAVIOR_MODE?: string; STREAM_FPS?: string; EVAL_INTERVAL_MS?: string; NARRATION_INTERVAL_MS?: string;
}
type Config = Record<string, { control_token: string; devices: Record<string, string>; profiles?: Record<string, Personality> }>;
type Action = ServerData['action']['action'];
type Peer = { ws: WebSocket; role: 'device' | 'viewer' | 'controller'; id: string; room: string; sid?: string; expires?: number; seen: number; frames: FrameWindow; lastMetricsRequest?: number; lastDebugRequest?: number; monitor?: boolean };
type Device = {
  id: string; room: string; mind: Mind; behavior?: Behavior; inbox: Dialogue[]; experienced: Set<string>; greeted: Set<string>; publicHistory: Dialogue[];
  peer?: Peer; stream: string | null; viewers: Set<Peer>; controller?: Peer;
  emotion: Emotion; status: DeviceStatus; seq: number; pan: number; tilt: number;
  order: number; inputId?: number; frames: Map<number, { order: number; at: number }>; detectedOrder: number;
  retryAt: number; lastDecision: number; lastAI: number; busy: boolean; gestureUntil: number; lastDetection: number; lastGesture: number;
  lastTextAt: number; textRetryAt: number; textEmotion?: Emotion;
  metrics: History; transport: Transport; lastTelemetry: number; lastTransportLog?: number; actionSentAt: Map<number, { sent: number; frame_at?: number }>; human: HumanActionState; lastChoice?: string; affectiveHistory: Experience[]; firstJoinAt: number | null; totalExperiences: number;
  headSource?: 'manual' | 'follow' | 'autonomous'; lastHeadAt?: number; manualUntil?: number; lastManualAt?: number; evaluation?: AbortController; follow?: FollowGate; lastFollowOrder?: number; lastFollowAt?: number;
  latest?: { bytes: Uint8Array; id: number; order: number; at: number };
};
type Identity = { human?: HumanActionState; version: 1; firstJoinAt: number; updatedAt: number; totalExperiences: number; mind: Mind; emotion: Emotion; affectiveHistory: Experience[]; publicHistory: Dialogue[]; experienced: string[] };
const MAX_FRAME_METADATA = 192; // >3s at the configured maximum 60fps, metadata only.
const ident = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const offline = (): DeviceStatus => ({ online: false, fps: 0, wifi_rssi: null, battery: null, current_action: 'idle' });
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const fail = (status: number, code: string, message = code) => json({ error: { code, message } }, status);
const config = (env: Env): Config => Object.assign(Object.create(null), JSON.parse(env.ROOM_CONFIG || '{}'));
function send<K extends keyof ServerData>(p: Peer, type: K, data: ServerData[K]) { try { p.ws.send(serializeServer(type, data)); } catch { /* close cleans up */ } }
function close(p: Peer, code: number, reason: string) {
  logCloseRequested({ room: p.room, id: p.id, stream: null }, p.role, code, reason);
  try { p.ws.close(code, reason); } catch { /* already closed */ }
}
async function equal(a: string, b: string) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  const xa = new Uint8Array(x), ya = new Uint8Array(y); let difference = 0;
  for (let i = 0; i < xa.length; i++) difference |= xa[i] ^ ya[i];
  return difference === 0;
}
const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
async function key(secret: string) { return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function sign(value: string, secret: string) {
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(value)));
  return b64(String.fromCharCode(...bytes));
}
async function session(req: Request, room: string, env: Env): Promise<{ sid: string; expires: number } | null> {
  try {
    const raw = (req.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`sc_control_${room}=`))?.split('=')[1];
    if (!raw || !env.SESSION_SECRET) return null;
    const [payload, signature] = raw.split('.');
    const bytes = Uint8Array.from(unb64(signature), c => c.charCodeAt(0));
    if (!await crypto.subtle.verify('HMAC', await key(env.SESSION_SECRET), bytes, new TextEncoder().encode(payload))) return null;
    const value = JSON.parse(unb64(payload));
    return value.room === room && value.expires > Date.now() && typeof value.sid === 'string' ? value : null;
  } catch { return null; }
}
async function deployment(env: Env, room: string, budgetVersion?: string | null) {
  const worker = env.VERSION_METADATA?.id || 'local';
  const [roomVersion, paidVersion] = await Promise.all([
    env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(`https://room.internal/list?room=${room}`).then(async r => r.ok ? ((await r.json()) as { runtime?: { version?: string } }).runtime?.version || (worker === 'local' ? 'local' : null) : null).catch(() => null),
    budgetVersion === undefined ? env.ROOMS.get(env.ROOMS.idFromName('__paid_budget__')).fetch('https://room.internal/paid-budget').then(r => r.headers.get('X-Stackchan-Version')).catch(() => null) : Promise.resolve(budgetVersion)
  ]);
  return deploymentStatus(worker, roomVersion, paidVersion);
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/monitor' || url.pathname === '/monitor/app.js') {
      const script = url.pathname.endsWith('.js');
      return new Response(script ? monitorJS : monitorHTML, { headers: {
        'Content-Type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      } });
    }
    if (url.pathname === '/health') {
      const budgetResponse = env.ENABLE_PAID_CONTROL === 'true' || env.AI_MODE === 'decisions' ? await env.ROOMS.get(env.ROOMS.idFromName('__paid_budget__')).fetch('https://room.internal/paid-budget') : null;
      const state: BudgetStatus = budgetResponse ? await budgetResponse.json() : paidSession(env);
      const requestedRoom = url.searchParams.get('room') || env.PAID_CONTROL_ROOM || 'main';
      const registered = config(env);
      const readiness = Object.hasOwn(registered, requestedRoom) ? await deployment(env, requestedRoom, budgetResponse?.headers.get('X-Stackchan-Version') ?? null) : null;
      const mode = env.ENABLE_PAID_CONTROL === 'true' ? state.active ? 'decisions' : 'mock' : env.AI_MODE || 'mock';
      return json({ deployment: readiness, paid_session: state, paid_control: { enabled: env.ENABLE_PAID_CONTROL === 'true', key_configured: !!env.OPENAI_API_KEY?.trim(), room: env.PAID_CONTROL_ROOM || 'main' }, ok: true, behavior_mode: behaviorMode(env), ai_mode: mode, protocol_version: 1, device_protocol_version: 2, ai_model: mode === 'decisions' ? DECISIONS_MODEL : null, narration_model: mode === 'decisions' ? DECISIONS_MODEL : null, ai_configured: mode !== 'decisions' || !!env.OPENAI_API_KEY?.trim(), pacing: pacing(env) });
    }
    if (url.pathname === '/' || url.pathname.startsWith('/lab')) {
      if (!env.ASSETS || (url.pathname.startsWith('/lab') && env.ENABLE_LAB !== 'true')) return fail(404, 'not_found');
      return env.ASSETS.fetch(req);
    }
    if (!env.SESSION_SECRET || !env.ALLOWED_ORIGIN || !env.ROOM_CONFIG) return fail(503, 'not_configured');
    let room = url.searchParams.get('room') || '';
    if (url.pathname === '/api/control/session' && req.method === 'POST') {
      if (req.headers.get('Origin') !== env.ALLOWED_ORIGIN) return fail(403, 'forbidden');
      if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return fail(400, 'invalid_request');
      if (Number(req.headers.get('Content-Length') || 0) > 16384) return fail(413, 'invalid_request');
      const text = await req.text(); if (new TextEncoder().encode(text).length > 16384) return fail(413, 'invalid_request');
      let body: any; try { body = JSON.parse(text); } catch { return fail(400, 'invalid_request'); }
      room = body?.room;
      if (typeof room !== 'string' || !ident.test(room) || typeof body.token !== 'string') return fail(400, 'invalid_request');
      if (!config(env)[room]) return fail(404, 'not_found');
      const internal = new Request(`https://room.internal/login?room=${room}`, { method: 'POST', body: JSON.stringify(body), headers: { 'X-Client-IP': req.headers.get('CF-Connecting-IP') || 'local', 'X-Secure': String(url.protocol === 'https:') } });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(internal);
    }
    if (url.pathname === '/api/control/head') {
      if (req.method !== 'POST') return fail(405, 'method_not_allowed');
      if (req.headers.get('Origin') !== env.ALLOWED_ORIGIN) return fail(403, 'forbidden');
      const id = url.searchParams.get('device_id') || '', registered = config(env)[room];
      if (!ident.test(room) || !ident.test(id) || !registered || !Object.hasOwn(registered.devices, id)) return fail(404, 'not_found');
      if (!await session(req, room, env)) return fail(401, 'unauthorized');
      if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return fail(400, 'invalid_request');
      if (Number(req.headers.get('Content-Length') || 0) > 1024) return fail(413, 'invalid_request');
      const text = await req.text(); if (new TextEncoder().encode(text).byteLength > 1024) return fail(413, 'invalid_request');
      let command: unknown; try { command = JSON.parse(text); } catch { return fail(400, 'invalid_request'); }
      if (!isHeadCommand(command)) return fail(400, 'invalid_head_action');
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(`https://room.internal/manual-head?room=${room}&device_id=${id}`, { method: 'POST', body: JSON.stringify(command) });
    }
    if (url.pathname === '/api/control/paid-session') {
      if (req.method !== 'POST') return fail(405, 'method_not_allowed');
      if (env.ENABLE_PAID_CONTROL !== 'true') return fail(403, 'control_disabled');
      if (req.headers.get('Origin') !== env.ALLOWED_ORIGIN) return fail(403, 'forbidden');
      if (room !== (env.PAID_CONTROL_ROOM || 'main') || !config(env)[room]) return fail(403, 'forbidden');
      if (!await session(req, room, env)) return fail(401, 'unauthorized');
      if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return fail(400, 'invalid_request');
      const body = await req.text(); if (new TextEncoder().encode(body).length > 1024) return fail(413, 'invalid_request');
      let command: any; try { command = JSON.parse(body); } catch { return fail(400, 'invalid_request'); }
      if (!command || !['start','stop'].includes(command.action) || Object.keys(command).some(k => !['action','seconds','max_calls'].includes(k))) return fail(400, 'invalid_request');
      if (command.action === 'start' && !(await deployment(env, room)).ready) return json({ error: { code: 'deployment_updating', message: '更新を反映中です。開始できるようになるまでお待ちください。' } }, 503, { 'Retry-After': '5' });
      const response = await env.ROOMS.get(env.ROOMS.idFromName('__paid_budget__')).fetch('https://room.internal/paid-control', { method: 'POST', headers: { 'X-Expected-Version': env.VERSION_METADATA?.id || 'local' }, body: JSON.stringify(command) });
      if (response.ok) await Promise.allSettled(Object.keys(config(env)).map(name => env.ROOMS.get(env.ROOMS.idFromName(name)).fetch('https://room.internal/paid-state-changed', { method: 'POST' })));
      return response;
    }
    const list = url.pathname.match(/^\/api\/rooms\/([a-z0-9_-]+)\/devices$/);
    if (list && req.method === 'GET') {
      room = list[1]; if (!ident.test(room) || !config(env)[room]) return fail(404, 'not_found');
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(`https://room.internal/list?room=${room}`);
    }
    if (!['/ws/device', '/ws/viewer', '/ws/monitor'].includes(url.pathname) || req.method !== 'GET') {
      if (env.ASSETS && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/ws/')) return env.ASSETS.fetch(req);
      return fail(404, 'not_found');
    }
    const id = url.searchParams.get('device_id') || '';
    if (!ident.test(room) || !ident.test(id) || (url.searchParams.has('control') && url.searchParams.get('control') !== '1')) return fail(400, 'invalid_request');
    const roomConfig = config(env)[room];
    if (!roomConfig || !Object.hasOwn(roomConfig.devices, id)) return fail(404, 'not_found');
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'upgrade_required');
    let role = 'viewer', auth = null;
    if (url.pathname === '/ws/device') {
      const token = req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!token || !await equal(token, roomConfig.devices[id])) return fail(401, 'unauthorized');
      role = 'device';
    } else {
      if (req.headers.get('Origin') !== env.ALLOWED_ORIGIN) return fail(403, 'forbidden');
      if (url.pathname === '/ws/monitor' || url.searchParams.get('control') === '1') {
        auth = await session(req, room, env); if (!auth) return fail(401, 'unauthorized'); role = url.pathname === '/ws/monitor' ? 'viewer' : 'controller';
      }
    }
    // DO is not exposed directly; overwrite any client-supplied internal headers.
    const headers = new Headers(req.headers);
    headers.set('X-Monitor', String(url.pathname === '/ws/monitor')); headers.set('X-Role', role); headers.set('X-Sid', auth?.sid || ''); headers.set('X-Expires', String(auth?.expires || 0));
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request(req, { headers }));
  }
} satisfies ExportedHandler<Env>;
export class Room {
  private devices = new Map<string, Device>();
  private loginAttempts = new Map<string, { count: number; until: number }>();
  private dialogue: Dialogue[] = [];
  private lastSpeech = 0;
  private timer?: ReturnType<typeof setInterval>;
  private identities = new Map<string, Identity>();
  private metricHistory = new Map<string, History>();
  private ready: Promise<void>;
  private lastRuntimeMode = 'not_evaluated';
  private apiDebug = new APIDebugCache();
  private activeAPICalls = new Map<string, ServerData['api_activity']>();
  private pendingAI = new Set<AbortController>();
  private rawFrames = new LatestFrames<{ d: Device; p: Peer; stream: string; raw: RawFrame; at: number; order: number }>();
  private conversionScheduled = false;
  private bigEndianDevices: Set<string>;
  constructor(private ctx: DurableObjectState, private env: Env, private aiFetch: typeof fetch = (input, init) => fetch(input, init)) {
    this.aiFetch = aiFetch;
    this.bigEndianDevices = new Set((env.RGB565_BIG_ENDIAN_DEVICES || '').split(',').map(id => id.trim()).filter(Boolean));
    this.ready = ctx.blockConcurrencyWhile(async () => {
      [this.identities, this.metricHistory] = await Promise.all([ctx.storage.list<Identity>({ prefix: 'identity:' }), ctx.storage.list<History>({ prefix: 'telemetry:' })]);
    });
  }
  private telemetry(d: Device, details: true): TelemetrySnapshot;
  private telemetry(d: Device, details?: false): TelemetrySummary;
  private telemetry(d: Device, details = false) { const full = snapshot(d.metrics, d.transport, pacing(this.env)); if (details) return full; const { samples, ...summary } = full; return summary; }
  private async finishRun(d: Device, run: Pipeline, started: number) {
    run.completed_at = Date.now(); run.duration_ms = Math.round(performance.now() - started);
    logRun(d, run);
    recordRun(d.metrics, run);
    this.metricHistory.set(`telemetry:${d.id}`, d.metrics);
    await this.ctx.storage.put(`telemetry:${d.id}`, d.metrics);
    this.broadcast(d, 'telemetry', this.telemetry(d)); d.lastTelemetry = Date.now();
  }
  private memory(d: Device) {
    return { scope: 'room_device' as const, first_join_at: d.firstJoinAt, last_saved_at: this.identities.get(`identity:${d.id}`)?.updatedAt || null, experience_count: d.affectiveHistory.length, total_experiences: d.totalExperiences };
  }
  private async persist(d: Device) {
    if (d.firstJoinAt === null) return;
    // Persist only bounded personal memory, never frames, socket state or executable commands.
    const record: Identity = structuredClone({ version: 1, human: initialHumanActions(d.human), firstJoinAt: d.firstJoinAt, updatedAt: Date.now(), totalExperiences: d.totalExperiences, mind: d.mind, emotion: d.emotion, affectiveHistory: d.affectiveHistory.slice(-6), publicHistory: d.publicHistory.slice(-10), experienced: [...d.experienced].slice(-100) });
    this.identities.set(`identity:${d.id}`, record);
    await this.ctx.storage.put(`identity:${d.id}`, record);
    this.broadcast(d, 'memory', this.memory(d));
  }
  private device(id: string, room: string) {
    let d = this.devices.get(id);
    if (!d) {
      const registered = config(this.env)[room];
      const saved = this.identities.get(`identity:${id}`);
      const configured = registered.profiles?.[id];
      const personality = saved?.mind.personality || (isPersonality(configured) ? configured : 'curious');
      d = { id, room, mind: initialMind(id, personality), inbox: [], experienced: new Set(), greeted: new Set(), publicHistory: [], metrics: this.metricHistory.get(`telemetry:${id}`) || newHistory(), transport: newTransport(null), lastTelemetry: 0, actionSentAt: new Map(), human: initialHumanActions(), affectiveHistory: [], firstJoinAt: null, totalExperiences: 0, stream: null, viewers: new Set(), emotion: initialEmotion(personality), status: offline(), seq: 0, pan: 0, tilt: 0, order: 0, frames: new Map(), detectedOrder: -1, retryAt: 0, lastDecision: -1, lastAI: 0, busy: false, gestureUntil: 0, lastDetection: 0, lastGesture: 0, lastTextAt: 0, textRetryAt: 0 };
      if (saved?.version === 1) {
        d.mind = { ...saved.mind, intent: 'observe', target: { kind: 'person', device_id: null }, cause: { kind: 'observation', message_id: null }, valid_until: 0 };
        d.human = initialHumanActions(saved.human);
        d.emotion = { ...saved.emotion }; d.affectiveHistory = saved.affectiveHistory.slice(-6); d.publicHistory = saved.publicHistory.slice(-10);
        d.experienced = new Set(saved.experienced); d.firstJoinAt = saved.firstJoinAt; d.totalExperiences = saved.totalExperiences;
      }
      this.devices.set(id, d);
    }
    return d;
  }
  private broadcast<K extends keyof ServerData>(d: Device, type: K, data: ServerData[K]) {
    if (!d.viewers.size) return;
    const payload = serializeServer(type, data);
    for (const p of d.viewers) { try { p.ws.send(payload); } catch { /* close cleans up */ } }
  }
  async fetch(req: Request): Promise<Response> {
    await this.ready;
    const url = new URL(req.url), room = url.searchParams.get('room')!;
    if (url.pathname === '/paid-budget') return json(this.env.ENABLE_PAID_CONTROL === 'true'
      ? await controlledBudget(this.ctx.storage, this.env, req.method === 'POST', url.searchParams.get('session_id') || undefined)
      : await reservePaidCall(this.ctx.storage, this.env, req.method === 'POST'), 200, { 'X-Stackchan-Version': this.env.VERSION_METADATA?.id || 'local' });
    if (url.pathname === '/paid-control' && req.method === 'POST') {
      try {
        const command = await req.json() as Parameters<typeof updatePaidSession>[2];
        const expected = req.headers.get('X-Expected-Version');
        if (command.action === 'start' && expected && expected !== (this.env.VERSION_METADATA?.id || 'local')) return fail(503, 'deployment_updating');
        const state = await updatePaidSession(this.ctx.storage, this.env, command);
        console.log({ event: 'paid_session_control', active: state.active, reason: state.reason, expires_at: state.expires_at, max_calls: state.max_calls, used_calls: state.used_calls });
        return json(state);
      } catch (error) { const code = error instanceof Error ? error.message : 'control_failed'; return fail(code === 'already_active' ? 409 : code === 'key_not_configured' ? 503 : code === 'control_disabled' ? 403 : 400, code); }
    }
    if (url.pathname === '/paid-state-changed' && req.method === 'POST') {
      for (const controller of this.pendingAI) controller.abort();
      for (const d of this.devices.values()) { d.follow = undefined; d.lastFollowOrder = -1; d.retryAt = 0; d.lastAI = 0; d.textRetryAt = 0; d.lastTextAt = 0; }
      return json({ ok: true });
    }
    if (url.pathname === '/login') {
      const now = Date.now(), ip = req.headers.get('X-Client-IP')!;
      for (const [key, value] of this.loginAttempts) if (value.until <= now) this.loginAttempts.delete(key);
      if (!this.loginAttempts.has(ip) && this.loginAttempts.size >= 1000) return fail(429, 'rate_limited');
      let attempt = this.loginAttempts.get(ip); if (!attempt) { attempt = { count: 0, until: now + 60000 }; this.loginAttempts.set(ip, attempt); }
      if (++attempt.count > 5) return fail(429, 'rate_limited');
      const body = await req.json() as { token: string };
      if (!await equal(body.token, config(this.env)[room].control_token)) return fail(401, 'unauthorized');
      const expires = Date.now() + 43200000, sid = crypto.randomUUID();
      const payload = b64(JSON.stringify({ room, sid, expires }));
      return json({ room, authenticated: true, expires_in: 43200 }, 200, { 'Set-Cookie': `sc_control_${room}=${payload}.${await sign(payload, this.env.SESSION_SECRET!)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.headers.get('X-Secure') === 'true' ? '; Secure' : ''}` });
    }
    if (url.pathname === '/manual-head' && req.method === 'POST') {
      const id = url.searchParams.get('device_id') || '', d = this.device(id, room);
      if (!d.peer || !d.stream) return fail(409, 'device_offline');
      const command: unknown = await req.json();
      if (!isHeadCommand(command)) return fail(400, 'invalid_head_action');
      const now = Date.now();
      if (now - (d.lastManualAt ?? -Infinity) < 100) return fail(429, 'head_rate_limited');
      d.lastManualAt = now;
      if (command.action === 'resume') d.manualUntil = 0;
      else {
        const target = manualTarget(d.pan, d.tilt, command.action); d.pan = target.pan; d.tilt = target.tilt; d.manualUntil = now + 10000;
        this.action(d, 'look_at', d.behavior?.command.expression || 'neutral', 500, '手動操作', undefined, false, true);
      }
      const result: HeadResponse = { ok: true, device_id: id, pan: d.pan, tilt: d.tilt, seq: d.seq, manual_until: d.manualUntil || 0 };
      return json(result);
    }
    if (url.pathname === '/list') return json({ room, runtime: { behavior_mode: behaviorMode(this.env), ai_mode: this.lastRuntimeMode, paid_control_enabled: this.env.ENABLE_PAID_CONTROL === 'true', key_configured: !!this.env.OPENAI_API_KEY?.trim(), version: this.env.VERSION_METADATA?.id || null }, devices: Object.keys(config(this.env)[room].devices).map(device_id => ({ device_id, online: !!this.device(device_id, room).peer })) });
    const id = url.searchParams.get('device_id')!, d = this.device(id, room);
    const role = req.headers.get('X-Role') as Peer['role'], sid = req.headers.get('X-Sid') || undefined;
    if (role === 'controller' && d.controller && d.controller.sid !== sid) return fail(409, 'controller_busy');
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    server.binaryType = 'arraybuffer';
    server.accept();
    const p: Peer = { ws: server, role, id, room, sid, expires: Number(req.headers.get('X-Expires')), seen: Date.now(), frames: new FrameWindow(), monitor: req.headers.get('X-Monitor') === 'true' };
    if (role === 'device') {
      if (d.peer) close(d.peer, 4001, 'replaced');
      this.cancelConversations(id);
      d.peer = undefined; d.stream = null;
      if (d.firstJoinAt === null) {
        const personality = choosePersonality(config(this.env)[room].profiles?.[id]);
        d.mind = initialMind(id, personality); d.emotion = initialEmotion(personality); d.firstJoinAt = Date.now();
      } else {
        d.mind = { ...d.mind, revision: d.mind.revision + 1, intent: 'observe', target: { kind: 'person', device_id: null }, cause: { kind: 'observation', message_id: null }, valid_until: 0 };
      }
      d.manualUntil = 0; d.lastManualAt = undefined; d.lastHeadAt = 0; d.headSource = undefined; d.evaluation?.abort(); d.follow = undefined; d.lastFollowOrder = -1; d.lastFollowAt = 0; d.retryAt = 0; d.lastGesture = 0; d.behavior = undefined; d.inbox = []; d.greeted.clear();
      d.lastTextAt = 0; d.textRetryAt = 0; d.textEmotion = undefined; d.lastChoice = undefined; d.human = initialHumanActions(d.human);
      await this.persist(d);
      d.peer = p; d.stream = crypto.randomUUID(); d.transport = newTransport(d.stream, this.bigEndianDevices.has(id) ? 'big' : 'little'); d.actionSentAt.clear(); d.latest = undefined; d.frames.clear();
      d.seq = 0; d.pan = 0; d.tilt = 0; this.rawFrames.cancel(d.id); d.inputId = undefined; d.order = 0; d.detectedOrder = -1; d.lastDecision = -1; d.gestureUntil = 0; d.lastDetection = 0;
      d.status = { online: true, fps: 0, wifi_rssi: null, battery: null, current_action: 'idle' };
      logConnection(d, true);
      for (const viewer of d.viewers) { viewer.frames.clear(); }
      this.broadcast(d, 'stream', { stream_id: d.stream }); this.broadcast(d, 'device_status', d.status); this.broadcast(d, 'emotion', d.emotion); this.broadcast(d, 'mind', d.mind); this.broadcast(d, 'behavior', null);
    } else {
      if (role === 'controller') { if (d.controller) { d.viewers.delete(d.controller); close(d.controller, 4001, 'replaced'); } d.controller = p; }
      d.viewers.add(p);
    }
    send(p, 'session', role === 'device' ? { ...deviceSession, behavior_mode: behaviorMode(this.env), room, device_id: id, role } : { protocol_version: 1, behavior_mode: behaviorMode(this.env), room, device_id: id, role });
    if (role !== 'device') { send(p, 'stream', { stream_id: d.stream }); send(p, 'emotion', d.emotion); send(p, 'device_status', d.status); send(p, 'mind', d.mind); send(p, 'behavior', d.behavior || null); send(p, 'dialogue_history', { messages: this.dialogue }); send(p, 'memory', this.memory(d)); send(p, 'telemetry', this.telemetry(d)); }
    if (p.monitor) for (const activity of this.activeAPICalls.values()) if (activity.device_id === id) send(p, 'api_activity', activity);
    server.addEventListener('message', event => this.message(p, d, event.data));
    server.addEventListener('close', event => this.cleanup(p, d, { code: event.code, reason: event.reason }));
    server.addEventListener('error', () => this.cleanup(p, d));
    if (!this.timer) this.timer = setInterval(() => this.tick(), 500);
    return new Response(null, { status: 101, webSocket: client });
  }
  private cleanup(p: Peer, d: Device, close?: { code: number; reason: string }) {
    if (p.role === 'device' && d.peer === p) {
      d.evaluation?.abort(); d.follow = undefined;
      if (this.rawFrames.cancel(d.id)) d.transport.conversion_dropped++;
      logConnection(d, false, close);
      this.cancelConversations(d.id);
      d.mind = { ...d.mind, revision: d.mind.revision + 1, intent: 'rest', target: { kind: 'none', device_id: null }, valid_until: 0 }; d.behavior = undefined;
      d.peer = undefined; d.stream = null; d.latest = undefined; d.frames.clear(); d.status = offline();
      this.broadcast(d, 'stream', { stream_id: null }); this.broadcast(d, 'device_status', d.status); this.broadcast(d, 'mind', d.mind); this.broadcast(d, 'behavior', null);
    }
    d.viewers.delete(p); if (d.controller === p) d.controller = undefined;
    if (![...this.devices.values()].some(x => x.peer || x.viewers.size)) { if (this.timer !== undefined) clearInterval(this.timer); this.timer = undefined; }
  }
  private reject(p: Peer, code = 'invalid_message', fatal = false) { send(p, 'error', { code, message: code }); if (fatal) close(p, 1008, code); }
  private message(p: Peer, d: Device, raw: string | ArrayBuffer) {
    if ((p.role === 'device' && d.peer !== p) || (p.role === 'controller' && d.controller !== p)) return;
    if ((p.role === 'controller' || p.monitor) && p.expires! <= Date.now()) { close(p, 4003, 'session_expired'); return; }
    if (typeof raw !== 'string') {
      if (p.role !== 'device') return this.reject(p, 'forbidden', true);
      if (raw.byteLength > RAW_PACKET_BYTES) { close(p, 1009, 'frame_too_large'); this.cleanup(p, d); return; }
      const input = parseRawFrame(raw);
      if (!input) { this.reject(p, 'invalid_raw_frame', true); this.cleanup(p, d); return; }
      const id = input.id;
      if (d.inputId !== undefined && (((id - d.inputId) >>> 0) >= 0x80000000 || id === d.inputId)) return;
      d.inputId = id;
      const at = Date.now(), order = ++d.order;
      receiveFrame(d.transport, raw.byteLength, at);
      send(p, 'frame_received', { stream_id: d.stream!, frame_id: id });
      if (this.rawFrames.put(d.id, { d, p, stream: d.stream!, raw: input, at, order })) d.transport.conversion_dropped++;
      this.scheduleConversion();
      return;
    }
    if (new TextEncoder().encode(raw).length > 16384) { close(p, 1009, 'message_too_large'); return; }
    const parsed = parseClientMessage(raw, p.role);
    if (!parsed.ok) { if (parsed.code === 'unknown_type') return; return this.reject(p, parsed.code, parsed.fatal); }
    const m = parsed.message;
    if (p.monitor && !['heartbeat', 'telemetry_request', 'api_debug_request'].includes(m.type)) return this.reject(p, 'forbidden', true);
    if (m.type === 'api_debug_request') {
      if (!p.monitor) return this.reject(p, 'forbidden', true);
      if (Date.now() - (p.lastDebugRequest || 0) < 250) return this.reject(p, 'debug_rate_limited');
      p.lastDebugRequest = Date.now();
      send(p, 'api_debug', { device_id: d.id, ...m.data, detail: this.apiDebug.get(`${d.id}:${m.data.run_id}:${m.data.stage}`) });
    } else if (m.type === 'telemetry_request') {
      if (Date.now() - (p.lastMetricsRequest || 0) < 1000) { send(p, 'error', { code: 'telemetry_rate_limited', message: 'Wait one second before requesting metrics again' }); return; }
      p.lastMetricsRequest = Date.now(); send(p, 'telemetry_snapshot', this.telemetry(d, true));
    } else if (m.type === 'frame_ack') {
      const a = m.data;
      if (a.stream_id === d.stream) {
        const rtt = p.frames.acknowledge(a.frame_id, performance.now());
        if (rtt !== undefined) addSample(d.transport.viewer_rtt, rtt);
      }
    } else if (m.type === 'action_ack') {
      const a = m.data;
      const sent = d.actionSentAt.get(a.seq);
      if (sent) { addSample(d.transport.action_rtt, performance.now() - sent.sent); if (a.accepted && sent.frame_at !== undefined) addSample(d.transport.frame_to_action_ack, Date.now() - sent.frame_at); if (!a.accepted) d.transport.rejected_actions++; d.actionSentAt.delete(a.seq); }
    } else if (m.type === 'device_status') {
      const a = m.data;
      if (a.transport?.upload_rtt_ms != null) addSample(d.transport.upload_rtt, a.transport.upload_rtt_ms);
      p.seen = Date.now(); d.status = { online: true, fps: a.fps, wifi_rssi: a.wifi_rssi, battery: a.battery, current_action: a.current_action };
      this.broadcast(d, 'device_status', d.status);
    } else if (m.type === 'heartbeat') {
      p.seen = Date.now(); send(p, 'heartbeat', {});
    } else if (m.type === 'detection') {
      const a = m.data;
      const primary = [...a.faces].sort((x, y) => y.width * y.height - x.width * x.height || x.id - y.id)[0];
      const frame = d.frames.get(a.frame_id);
      if (a.stream_id !== d.stream || !frame || Date.now() - frame.at > 3000 || frame.order <= d.detectedOrder) return;
      d.detectedOrder = frame.order; d.lastDetection = Date.now();
      // In follow mode only Decisions perception chooses steering. FE coordinates
      // may describe another frame/target and must never override its direction.
      if (behaviorMode(this.env) === 'follow_person') return;
      if (Date.now() < (d.manualUntil || 0) || d.gestureUntil > Date.now() || d.mind.intent !== 'observe') return;
      if (!primary) { this.action(d, 'idle', 'neutral', 500); return; }
      d.pan = clamp(d.pan + (primary.x + primary.width / 2 - .5) * .3, -1, 1);
      d.tilt = clamp(d.tilt - (primary.y + primary.height / 2 - .5) * .3, -1, 1);
      this.action(d, 'look_at', 'thinking', 500, '興味を示しながら、相手へ視線を向ける');
    }
  }
  private scheduleConversion() {
    if (this.conversionScheduled || !this.rawFrames.size) return;
    this.conversionScheduled = true;
    // Yield between encodes so incoming frames can replace a pending frame.
    setTimeout(async () => {
      const item = this.rawFrames.take();
      try {
        if (!item) return;
        const { d, p, stream, raw, at, order } = item;
        if (d.peer !== p || d.stream !== stream || Date.now() - at > RAW_MAX_AGE_MS) { d.transport.conversion_dropped++; return; }
        const transport = d.transport, started = performance.now(), packet = encodeRawFrame(raw, d.transport.input_byte_order);
        // Production Workers clocks advance on I/O only. Include a timer yield so
        // the bounded sample measures encode + scheduler wall time, never fake CPU=0.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const completed = performance.now();
        addSample(transport.conversion_ms, completed - started); transport.converted_total++;
        // New ingress must not starve completed JPEGs. Publish in ingress order
        // while fresh; the next conversion consumes the newest pending raw frame.
        if (d.peer !== p || d.stream !== stream || order <= (d.latest?.order ?? -1) || Date.now() - at > RAW_MAX_AGE_MS) { transport.conversion_dropped++; return; }
        transport.published_total++;
        d.latest = { bytes: packet.subarray(4), id: raw.id, order, at };
        d.frames.set(raw.id, { order, at });
        for (const [key, value] of d.frames) { if (at - value.at <= RAW_MAX_AGE_MS && d.frames.size <= MAX_FRAME_METADATA) break; d.frames.delete(key); }
        for (const viewer of d.viewers) {
          if (viewer.monitor) continue;
          if (!viewer.frames.canSend(packet.byteLength, completed)) { close(viewer, 1013, 'slow_viewer'); this.cleanup(viewer, d); continue; }
          try { viewer.ws.send(packet); viewer.frames.sent(raw.id, packet.byteLength, completed); } catch { this.cleanup(viewer, d); }
        }
      } catch {
        if (item) { item.d.transport.conversion_errors++; if (item.d.peer === item.p) this.reject(item.p, 'conversion_failed'); }
      } finally { this.conversionScheduled = false; this.scheduleConversion(); }
    }, 0);
  }
  private action(d: Device, action: Action, expression: Motion['expression'], duration_ms: number, display_text = '穏やかな表情で待つ', run?: Pipeline, following = false, manual = false) {
    if (!d.peer || (!manual && Date.now() < (d.manualUntil || 0)) || (!manual && behaviorMode(this.env) === 'follow_person' && !following)) return;
    if (['nod', 'shake', 'happy'].includes(action)) { d.gestureUntil = Date.now() + duration_ms; d.lastGesture = Date.now(); }
    d.lastHeadAt = Date.now(); d.headSource = manual ? 'manual' : following ? 'follow' : 'autonomous';
    const command = toDeviceMotion({ seq: ++d.seq, action, pan: d.pan, tilt: d.tilt, expression, duration_ms });
    d.actionSentAt.set(command.seq, { sent: performance.now(), frame_at: run?.frame_received_at });
    if (d.actionSentAt.size > 32) d.actionSentAt.delete(d.actionSentAt.keys().next().value!);
    send(d.peer, 'action', command);
    d.behavior = { device_id: d.id, mind_revision: d.mind.revision, display_text, command, issued_at: Date.now() };
    this.broadcast(d, 'behavior', d.behavior);
  }
  private tick() {
    const now = Date.now(), monotonicNow = performance.now();
    for (const d of this.devices.values()) {
      if (d.follow && !followFresh(d.follow, d.stream, now)) d.follow = undefined;
      if (d.peer && now - (d.lastHeadAt || 0) >= 1000) {
        if (now < (d.manualUntil || 0)) this.action(d, 'look_at', d.behavior?.command.expression || 'neutral', 500, '手動操作', undefined, false, true);
        else if (behaviorMode(this.env) === 'follow_person' && d.headSource === 'follow' && followFresh(d.follow, d.stream, now)) this.action(d, 'look_at', d.behavior?.command.expression || 'thinking', 250, '人物に追従（位置保持）', undefined, true);
      }
      if (now - d.lastTelemetry >= 5000) { const data = this.telemetry(d); this.broadcast(d, 'telemetry', data);  d.lastTelemetry = now; }
      if (d.peer && now - (d.lastTransportLog || 0) >= 5000) { logTransport(d, this.telemetry(d)); d.lastTransportLog = now; }
      for (const viewer of d.viewers) if (viewer.frames.expired(monotonicNow)) { close(viewer, 1013, 'slow_viewer'); this.cleanup(viewer, d); }
      for (const viewer of d.viewers) if (viewer.monitor && viewer.expires! <= now) { close(viewer, 4003, 'session_expired'); this.cleanup(viewer, d); }
      // Device silence alone does not close the socket; explicit close/error or replacement cleans up.
      if (d.controller && (d.controller.expires! <= now || now - d.controller.seen >= 15000)) {
        const p = d.controller; close(p, p.expires! <= now ? 4003 : 4000, 'controller_timeout'); this.cleanup(p, d);
      }
      if (d.lastDetection && d.mind.intent === 'observe' && now - d.lastDetection > 3000 && now >= d.gestureUntil) { this.action(d, 'idle', 'neutral', 500); d.lastDetection = 0; }
      if ((this.env.ENABLE_PAID_CONTROL === 'true' || this.env.AI_MODE !== 'decisions' || paidSession(this.env).active) && d.peer && d.latest && now >= d.retryAt && !d.busy && now - d.lastAI >= pacing(this.env).evaluation_interval_ms && d.latest.order > d.lastDecision && now - d.latest.at <= 3000) {
        const stream = d.stream;
        d.lastAI = now; d.busy = true;
        const started = performance.now();
        const run: Pipeline = { id: crypto.randomUUID(), stream_id: stream!, frame_id: d.latest.id, frame_received_at: d.latest.at, started_at: now, completed_at: 0, duration_ms: 0, outcome: 'discarded', reason: 'state_changed', api: [] };
        const controller = new AbortController(); d.evaluation = controller; this.pendingAI.add(controller);
        this.ctx.waitUntil(this.decide(d, run, controller.signal).catch(error => {
          if (controller.signal.aborted) { run.reason = d.stream === stream ? 'paid_session_changed' : 'stream_changed'; return; }
          run.outcome = 'error'; run.reason = error instanceof OpenAIError ? `http_${error.status}` : 'evaluation_failed';
          const last = run.api.at(-1);
          if (d.stream === stream && last?.stage === 'perception') d.follow = undefined; if (error instanceof Error && /^(Invalid|Missing|Duplicate)/.test(error.message) && last?.outcome === 'success') last.outcome = 'invalid_response';
          if (d.stream !== stream) return;
          const retry = error instanceof OpenAIError ? error.retryAfterMs : 10000;
          d.retryAt = Date.now() + retry;
          this.broadcast(d, 'error', { code: 'ai_unavailable', message: error instanceof OpenAIError ? error.message : 'AI evaluation failed; state preserved', retry_after_ms: retry });
        }).finally(async () => { this.pendingAI.delete(controller); if (d.evaluation === controller) { d.evaluation = undefined; d.busy = false; } await this.finishRun(d, run, started); }));
      }
    }
  }
  private async decide(d: Device, run: Pipeline, signal: AbortSignal) {
    const frame = d.latest!, stream = d.stream!, before = { ...d.emotion };
    const following = behaviorMode(this.env) === 'follow_person';
    const controlled = this.env.ENABLE_PAID_CONTROL === 'true';
    const status: BudgetStatus | undefined = controlled ? await (await this.env.ROOMS.get(this.env.ROOMS.idFromName('__paid_budget__')).fetch('https://room.internal/paid-budget')).json() : undefined;
    if (signal.aborted || d.stream !== stream || !d.peer) return;
    const mode = controlled ? status?.active ? 'decisions' : 'mock' : this.env.AI_MODE;
    this.lastRuntimeMode = mode || 'unknown';
    const canFollow = following && (!controlled || mode === 'decisions');
    if (following && !canFollow) d.follow = undefined;
    const runEnv = controlled ? { AI_MODE: mode, PAID_SESSION_ID: status?.session_id || '', PAID_SESSION_UNTIL: String(status?.expires_at || 0), PAID_SESSION_UNLIMITED: status?.active && status.expires_at === null ? 'true' : 'false', PAID_SESSION_MAX_CALLS: String(status?.max_calls || 0) } : this.env;
    const aiFetch = guardedFetch(runEnv, async () => {
      const url = new URL('https://room.internal/paid-budget');
      if (controlled) url.searchParams.set('session_id', status?.session_id || '');
      return (await this.env.ROOMS.get(this.env.ROOMS.idFromName('__paid_budget__')).fetch(url.toString(), { method: 'POST' })).json();
    }, (input, init) => this.aiFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }));
    const calls: CallMetrics[] = [];
    const started = Date.now();
    d.inbox = d.inbox.filter(m => m.expires_at > started && m.to_stream_id === stream && this.devices.get(m.from_device_id)?.stream === m.from_stream_id);
    const incoming = d.inbox[0], incomingIsNew = !!incoming && !d.experienced.has(incoming.id), peers = this.publicPeers(d);
    const historySize = d.affectiveHistory.length;
    let evaluation: ReturnType<typeof parseEvaluation>;
    if (mode === 'mock') {
      evaluation = mockEvaluation(frame.id, before, d.mind.personality, incomingIsNew, d.affectiveHistory, following);
    } else if (mode === 'decisions') {
      const bytes = frame.bytes; let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const first = await this.ask(d, run, 'perception', evaluationPayload(`data:image/jpeg;base64,${btoa(binary)}`, socialContext(d.mind, before, undefined, peers, incoming, started, d.publicHistory.slice(-6)), d.affectiveHistory, incomingIsNew, following), calls, aiFetch);
      evaluation = parseEvaluation(first, following);
    } else throw new Error('Unknown AI_MODE');
    const { observations, emotion: next } = evaluation;
    const valid = () => !signal.aborted && d.stream === stream && !!d.peer && Date.now() - frame.at <= 10000 && frame.order > d.lastDecision;
    if (!valid()) { run.reason = 'stale_frame_or_stream'; return; }
    let trackingIssued = false;
    if (canFollow && frame.order > (d.lastFollowOrder ?? -1)) {
      // A stopped/expired session must not authorize even the early neck command.
      if (controlled && mode === 'decisions') {
        const current: BudgetStatus = await (await this.env.ROOMS.get(this.env.ROOMS.idFromName('__paid_budget__')).fetch('https://room.internal/paid-budget')).json();
        if (current.session_id !== status?.session_id || ['stopped','expired','deployment_changed','not_started'].includes(current.reason || '')) { d.follow = undefined; run.reason = 'paid_session_stopped'; return; }
      }
      if (!valid() || Date.now() - frame.at > FOLLOW_MAX_AGE_MS) { d.follow = undefined; run.reason = 'stale_follow_frame'; return; }
      d.lastFollowOrder = frame.order;
      d.follow = observations.person_present >= .5 ? { stream, order: frame.order, frameAt: frame.at, until: Math.min(frame.at + FOLLOW_MAX_AGE_MS, mode === 'decisions' ? (controlled ? status?.expires_at ?? Infinity : paidSession(this.env).expires_at ?? 0) : Infinity) } : undefined;
      const target = d.follow && evaluation.position ? coarseTarget(d.pan, d.tilt, evaluation.position) : null;
      if (!target && d.headSource === 'follow') d.headSource = undefined;
      if (target && Date.now() >= (d.manualUntil || 0) && followFresh(d.follow, d.stream, Date.now())) {
        d.pan = target.pan; d.tilt = target.tilt; d.lastFollowAt = Date.now(); trackingIssued = true;
        this.action(d, 'look_at', 'thinking', 250, mode === 'mock' ? '人物に追従（mock）' : '人物に追従', run, true);
      }
    }
    const now = Date.now();
    const scan = scanHumanActions(d.human, observations, { order: frame.order, frame_id: frame.id, stream_id: stream!, at: now });
    d.human = scan.state;
    if (scan.created) this.broadcast(d, 'human_action', scan.created);
    const humanEvent = d.human.pending[0];
    const context = () => ({ ...socialContext(d.mind, next, observations, peers, incoming, now, d.publicHistory.slice(-6)), previous_choice: d.lastChoice || null, human_action: humanEvent || null, own_affective_history: projectExperiences(d.affectiveHistory) });
    const readyToSpeak = now - this.lastSpeech >= 2000;
    const available = ['observe', 'avert', 'rest'];
    if (observations.person_present >= .5 && (humanEvent || ['acknowledge_person', 'delight'].includes(d.lastChoice || ''))) available.push('acknowledge_person', 'delight');
    if (incoming?.speech_act === 'acknowledge') available.push(`listen:${incoming.from_device_id}`);
    else if (readyToSpeak && incoming) available.push(`reply:${incoming.from_device_id}`);
    else if (readyToSpeak) {
      for (const peer of peers) if (!d.greeted.has(peer.stream_id)) available.push(`greet:${peer.device_id}`);
    }
    let choice: string, confidence = .9;
    const newCompanion = ['curious', 'cheerful', 'playful'].includes(d.mind.personality) && d.mind.intent === 'observe' && available.some(c => c.startsWith('greet:'));
    const held = now < d.mind.valid_until && !humanEvent && !newCompanion && !available.some(c => c.startsWith('reply:') || c.startsWith('listen:'));
    if (held) choice = d.mind.intent === 'avert' ? 'avert' : d.mind.intent === 'rest' ? 'rest' : 'observe';
    else if (mode === 'mock') choice = mockChoice(d.mind.personality, available, observations.person_present >= .5, d.mind.intent, humanEvent, d.affectiveHistory);
    else {
      const response = await this.ask(d, run, 'intention', { input: JSON.stringify(context()), questions: [{ type: 'choice', name: 'intention', instructions: "Choose this fictional robot's own intention from observations, its personality, emotional state and public interactions. A shy robot may be glad but hide it by averting its gaze or politely nodding. Do not mirror a human expression. Peers' private thoughts are not available. Only received_utterance is a message addressed to you. Online peers can be greeted even without a human in the camera. A curious robot generally prefers greeting a new available peer once over resting alone, and receiving a friendly greeting or acknowledgement over ignoring it. A human_action is a newly confirmed change, not a repeated pose or proof of actual waving motion. Reassess it using your personality, feelings and own_affective_history. You may acknowledge a raised hand, delight, avert your gaze, watch quietly or rest. Do not always reciprocate. If human_action is null and the situation is unchanged, prefer continuity with previous_choice. Pick rest if there is no person, no available new peer and no received interaction.", choices: available.map(value => ({ value, description: value.startsWith('listen:') ? 'Receive an acknowledgement and respond nonverbally, without another utterance' : value.startsWith('reply:') ? 'Reply once to the received greeting' : value.startsWith('greet:') ? 'Greet this online peer and invite company, even if no human is visible' : ({ acknowledge_person: 'Give one small nonverbal nod to the visible person', delight: 'Show a brief happy gesture toward the visible person', observe: 'Watch the person with curiosity', avert: 'Keep interest private and avert your gaze', rest: 'Wait quietly' } as Record<string, string>)[value] })) }] }, calls, aiFetch);
      const answer = response.answers?.find((a: any) => a.name === 'intention');
      if (answer?.type !== 'choice' || !available.includes(answer.choice) || !finite(answer.confidence)) throw new Error('Invalid intention');
      choice = answer.choice; confidence = answer.confidence;
    }
    if (!valid()) { run.reason = 'stale_frame_or_stream'; return; }
    const isSpeech = choice.startsWith('reply:') || choice.startsWith('greet:');
    const isReceived = choice.startsWith('reply:') || choice.startsWith('listen:');
    let peer: Device | undefined;
    const socialValid = () => {
      if (isSpeech || isReceived) {
      peer = this.devices.get(choice.slice(choice.indexOf(':') + 1));
      const expected = peers.find(p => p.device_id === peer?.id);
      if (!peer?.peer || peer.stream !== expected?.stream_id || (isSpeech && Date.now() - this.lastSpeech < 2000) || (isReceived && (!incoming || incoming.expires_at <= Date.now() || incoming.from_stream_id !== peer.stream))) return false;
      }
      return !incoming || (incoming.expires_at > Date.now() && this.devices.get(incoming.from_device_id)?.stream === incoming.from_stream_id && d.inbox.some(m => m.id === incoming.id));
    };
    if (!socialValid()) { run.reason = 'social_state_changed'; return; }
    if (!following && !held && Date.now() < d.gestureUntil) { run.reason = 'gesture_busy'; return; }
    const plan = planFor(choice, d.mind.personality);
    let text = { thought: d.mind.thought, public_text: null as string | null }, generation = d.mind.generation;
    if (!held && (!!humanEvent || needsNarration(d.mind, choice, next, d.textEmotion))) {
      text = fallbackNarration(choice, plan.thought, personalities[d.mind.personality].restrained, observations.person_present >= .5);
      if (mode === 'mock') {
        text = mockNarration(choice, plan.thought, personalities[d.mind.personality].restrained, observations);
        generation = { provider: 'mock', model: null, reason: null };
        d.textEmotion = { ...next };
      } else if (Date.now() < d.textRetryAt || Date.now() - d.lastTextAt < pacing(this.env).narration_interval_ms) {
        generation = { provider: 'fallback', model: null, reason: 'cooldown' };
      } else {
        d.lastTextAt = Date.now();
        try {
          const generated = await this.traceCall(d, run, 'narration', 'responses', (observer, debug) => callNarration(this.env.OPENAI_API_KEY || '', narrationPayload(context(), choice), isSpeech, aiFetch, 3000, observer, debug));
          text = generated.text; calls.push(generated.metrics);
          generation = { provider: 'openai', model: DECISIONS_MODEL, reason: null };
        } catch (error) {
          if (!valid()) { run.reason = 'stale_frame_or_stream'; return; }
          d.textRetryAt = Date.now() + (error instanceof OpenAIError ? error.retryAfterMs : 10000);
          generation = { provider: 'fallback', model: null, reason: error instanceof OpenAIError && error.status === 429 ? 'rate_limit' : 'api_error' };
        }
        if (!valid() || !socialValid()) return;
        if (generation.provider === 'openai') d.textEmotion = { ...next };
      }
    }
    if (controlled && mode === 'decisions') {
      const current: BudgetStatus = await (await this.env.ROOMS.get(this.env.ROOMS.idFromName('__paid_budget__')).fetch('https://room.internal/paid-budget')).json();
      if (current.session_id !== status?.session_id || ['stopped','expired','deployment_changed','not_started'].includes(current.reason || '')) { run.reason = 'paid_session_stopped'; return; }
    }
    // Network waits must not commit old streams, vanished peers or expired events.
    if (!valid() || !socialValid() || (humanEvent && humanEvent.expires_at <= Date.now())) return;
    run.outcome = 'committed'; run.reason = 'accepted';
    d.lastDecision = frame.order; d.emotion = next;
    let relationships = d.mind.relationships;
    if (incoming && !d.experienced.has(incoming.id)) {
      d.experienced.add(incoming.id); while (d.experienced.size > 100) d.experienced.delete(d.experienced.values().next().value!);
      relationships = { ...relationships, [incoming.from_device_id]: clamp((relationships[incoming.from_device_id] ?? .5) + .1) };
    }
    // A held intention remains intact: no repeated gesture or speech on each frame.
    if (!held) {
      d.mind = { device_id: d.id, revision: d.mind.revision + 1, personality: d.mind.personality, intent: plan.intent, target: plan.target, thought: text.thought, generation, relationships, cause: { kind: isReceived ? 'dialogue' : humanEvent ? 'human_action' : 'observation', message_id: isReceived ? incoming!.id : null, ...(humanEvent ? { event_id: humanEvent.id } : {}) }, valid_until: Date.now() + 6000 };
      if (!following && Date.now() >= (d.manualUntil || 0) && plan.pan !== undefined) d.pan = plan.pan;
      if (!following && Date.now() >= (d.manualUntil || 0) && plan.tilt !== undefined) d.tilt = plan.tilt;
      this.broadcast(d, 'mind', d.mind);
    }
    if (held && relationships !== d.mind.relationships) { d.mind = { ...d.mind, relationships }; this.broadcast(d, 'mind', d.mind); }
    const humanGesture = choice === 'acknowledge_person' || choice === 'delight';
    const issueCommand = Date.now() >= (d.manualUntil || 0) && !following && !held && (!d.behavior || !!humanEvent || isSpeech || isReceived || (!humanGesture && d.lastChoice !== choice));
    const trigger = humanEvent ? 'human_action' : isReceived ? 'dialogue' : newCompanion ? 'companion' : held ? 'held' : !d.lastChoice ? 'initial' : 'periodic';
    if (!held) d.lastChoice = choice;
    this.broadcast(d, 'emotion', d.emotion);
    const affect: Affect = { provider: mode === 'decisions' ? 'openai' : 'mock', model: mode === 'decisions' ? DECISIONS_MODEL : null, previous_emotion: before, confidence: evaluation.confidence, history_size: historySize, received_message_is_new: incomingIsNew };
    this.broadcast(d, 'decision', { stream_id: stream, frame_id: frame.id, observations, affect, human_action: humanEvent || null, reaction: { trigger, intent_reassessed: !held, command_issued: issueCommand || trackingIssued, selected_choice: choice, event_id: humanEvent?.id || null }, selected_action: issueCommand ? plan.action : d.behavior?.command.action || 'idle', confidence, mind_revision: d.mind.revision, intent: d.mind.intent, ai: summarizeCalls(calls, mode === 'decisions') });
    const lastExperience = d.affectiveHistory.at(-1);
    if (!lastExperience || humanEvent || incomingIsNew || lastExperience.intent !== d.mind.intent || emotionKeys.some(k => Math.abs(lastExperience.emotion_after[k] - next[k]) >= .1)) {
      d.totalExperiences++;
      d.affectiveHistory = [...d.affectiveHistory, { at: Date.now(), kind: incomingIsNew ? 'dialogue' as const : humanEvent ? 'human_action' as const : 'observation' as const, message_id: incomingIsNew ? incoming!.id : null, ...(humanEvent ? { human_action: { id: humanEvent.id, changes: humanEvent.changes } } : {}), emotion_before: before, emotion_after: { ...next }, intent: d.mind.intent, expression: observations.apparent_expression.label }].slice(-6);
    }
    if (issueCommand && Date.now() >= d.gestureUntil) this.action(d, plan.action, plan.expression, plan.duration_ms, plan.display_text, run);
    if (!held && isSpeech && peer && text.public_text) this.speak(d, peer, text.public_text, choice.startsWith('reply:') ? incoming : undefined);
    if (!held && choice.startsWith('listen:')) d.inbox = d.inbox.filter(m => m.id !== incoming!.id);
    if (humanEvent) consumeHumanAction(d.human, humanEvent.id);
    await this.persist(d);
  }
  private publicPeers(self: Device): PublicPeer[] {
    return [...this.devices.values()].filter(d => d !== self && d.peer && d.stream).sort((a, b) => a.id.localeCompare(b.id)).map(d => ({ device_id: d.id, stream_id: d.stream!, action: d.behavior?.command.action || 'idle', expression: d.behavior?.command.expression || 'neutral' }));
  }
  private speak(from: Device, to: Device, text: string, reply?: Dialogue) {
    const now = Date.now();
    const event: Dialogue = { id: crypto.randomUUID(), room: from.room, from_device_id: from.id, to_device_id: to.id, from_stream_id: from.stream!, to_stream_id: to.stream!, reply_to: reply?.id || null, speech_act: reply ? 'acknowledge' : 'greet', text, created_at: now, expires_at: now + 12000 };
    this.lastSpeech = now;
    from.greeted.add(to.stream!); to.greeted.add(from.stream!);
    for (const d of [from, to]) while (d.greeted.size > 100) d.greeted.delete(d.greeted.values().next().value!);
    if (reply) from.inbox = from.inbox.filter(m => m.id !== reply.id);
    // Acknowledgements can cause a nonverbal reaction, never another utterance.
    to.inbox = [...to.inbox, event].slice(-10);
    for (const d of [from, to]) d.publicHistory = [...d.publicHistory, event].slice(-10);
    this.dialogue = [...this.dialogue, event].slice(-20);
    this.ctx.waitUntil(this.persist(to));
    const viewers = new Set([...this.devices.values()].flatMap(d => [...d.viewers]));
    for (const viewer of viewers) send(viewer, 'dialogue', event);
  }
  private cancelConversations(id: string) {
    for (const d of this.devices.values()) d.inbox = d.inbox.filter(m => m.from_device_id !== id && m.to_device_id !== id);
  }
  private async traceCall<T>(d: Device, run: Pipeline, stage: Stage, endpoint: CallMetrics['endpoint'], operation: (observer: (sample: APITiming) => void, debug: (detail: APIDebug) => void) => Promise<T>): Promise<T> {
    const base = { call_id: crypto.randomUUID(), run_id: run.id, stream_id: run.stream_id, device_id: d.id, stage, endpoint, model: DECISIONS_MODEL };
    const started: ServerData['api_activity'] = { ...base, state: 'started', started_at: Date.now() };
    this.activeAPICalls.set(base.call_id, started);
    for (const peer of d.viewers) if (peer.monitor) send(peer, 'api_activity', started);
    try {
      return await operation(sample => {
        const entry = { ...sample, stage, run_id: run.id, stream_id: run.stream_id }; run.api.push(entry);
        for (const peer of d.viewers) if (peer.monitor) send(peer, 'api_activity', { ...base, state: 'completed', sample: entry });
      }, detail => this.apiDebug.put(`${d.id}:${run.id}:${stage}`, detail));
    } finally { this.activeAPICalls.delete(base.call_id); }
  }
  private async ask(d: Device, run: Pipeline, stage: Stage, payload: object, calls: CallMetrics[], aiFetch: typeof fetch): Promise<any> {
    const { body, metrics } = await this.traceCall(d, run, stage, 'decisions', (observer, debug) => callDecisions(this.env.OPENAI_API_KEY || '', payload, aiFetch, 4000, observer, debug));
    calls.push(metrics);
    return body;
  }
}
