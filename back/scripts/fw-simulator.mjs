import { parseDeviceServerMessage, serializeClient } from '../src/protocol.ts';
/** @typedef {import('../src/protocol.ts').Motion} Motion */
/** @typedef {{ type: string, device_id?: string, data?: unknown }} SimulatorEvent */
/** @typedef {{ base?: string, room?: string, id?: string, token: string, fps?: number, files?: string[], sharedImage?: boolean, notify?: (event: SimulatorEvent) => void }} SimulatorOptions */
import WebSocket, { WebSocketServer } from 'ws';
import sharp from 'sharp';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** @param {number} frame */
export function geometry(frame) { return { x: .5 + .2 * Math.sin(frame / 8) - .15, y: .36 + .06 * Math.cos(frame / 10) - .2, width: .3, height: .4 }; }
/** @param {number} frame */
export async function syntheticJPEG(frame, device = 'stackchan-01') {
  const f = geometry(frame), x = (f.x + .15) * 320, y = (f.y + .2) * 240;
  const scene = Math.floor(frame / 8) % 6;
  const eyes = `<circle cx="${x - 17}" cy="${y - 9}" r="${scene === 1 ? 8 : 5}" fill="#15282d"/><circle cx="${x + 17}" cy="${y - 9}" r="${scene === 1 ? 8 : 5}" fill="#15282d"/>`;
  const mouth = scene === 1 ? `<ellipse cx="${x}" cy="${y + 19}" rx="9" ry="12" fill="#15282d"/>` : `<path d="M${x - 18} ${y + 12} Q${x} ${y + (scene === 0 || scene === 4 ? 35 : scene === 5 ? 12 : -2)} ${x + 18} ${y + 12}" fill="none" stroke="#15282d" stroke-width="4" stroke-linecap="round"/>`;
  const brows = scene === 2 ? `<path d="M${x - 28} ${y - 25} L${x - 8} ${y - 17} M${x + 8} ${y - 17} L${x + 28} ${y - 25}" stroke="#15282d" stroke-width="4" stroke-linecap="round"/>` : '';
  const tears = scene === 3 ? `<path d="M${x - 18} ${y + 1} Q${x - 31} ${y + 28} ${x - 18} ${y + 31} Q${x - 5} ${y + 28} ${x - 18} ${y + 1} M${x + 18} ${y + 1} Q${x + 5} ${y + 28} ${x + 18} ${y + 31} Q${x + 31} ${y + 28} ${x + 18} ${y + 1}" fill="#8ac6ed"/>` : '';
  const hand = scene === 4 ? `<path d="M${x + 43} ${y + 30} Q${x + 73} ${y + 10} ${x + 82} ${y - 28} M${x + 82} ${y - 28} l-8 -15 m8 15 l1 -20 m-1 20 l10 -16 m-10 16 l17 -8" fill="none" stroke="#7edccc" stroke-width="6" stroke-linecap="round"/>` : '';
  const accent = device.endsWith('02') ? '#eeb66b' : '#7edccc';
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#15282d"/><path d="M0 190H320M80 0V240M160 0V240M240 0V240" stroke="#294047"/><rect x="12" y="12" width="296" height="26" rx="5" fill="#203b42"/><text x="20" y="30" fill="${accent}" font-family="sans-serif" font-size="13">${device} / FRAME ${frame}</text><ellipse cx="${x}" cy="${y}" rx="48" ry="48" fill="${accent}"/>${eyes}${mouth}${brows}${tears}${hand}<text x="16" y="221" fill="#a3bdc2" font-family="sans-serif" font-size="12">SIMULATED CAMERA / 320 x 240 / 2 FPS</text></svg>`)).jpeg({ quality: 75 }).toBuffer();
}
export class Simulator {
  /** @type {WebSocket | undefined} */ ws;
  /** @type {ReturnType<typeof setInterval> | undefined} */ frameTimer;
  /** @type {ReturnType<typeof setInterval> | undefined} */ statusTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ retry;
  /** @type {Buffer | null} */ cameraJPEG = null;
  /** @type {WebSocket | null} */ cameraPeer = null;
  sending = false;
  /** @param {SimulatorOptions} options */
  constructor({ base = 'http://127.0.0.1:8787', room = 'main', id = 'stackchan-01', token, fps = 60, files = [], sharedImage = false, notify = () => {} }) {
    this.base = base; this.room = room; this.id = id; this.token = token; this.fps = fps; this.files = files; this.sharedImage = sharedImage; this.notify = notify;
    if (!Number.isFinite(fps) || fps <= 0 || fps > 60) throw new Error('fps must be > 0 and <= 60');
    this.frame = 0; this.lastSeq = 0; this.frameSentAt = new Map();
    /** @type {number | null} */ this.uploadRTT = null;
    /** @type {Pick<Motion, 'action' | 'pan' | 'tilt' | 'expression'>} */ this.action = { action: 'idle', pan: 0, tilt: 0, expression: 'neutral' };
    this.connected = false; this.stopped = false; this.attempt = 0; this.gestureUntil = 0;
  }
  start() {
    const url = new URL('/ws/device', this.base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = new URLSearchParams({ room: this.room, device_id: this.id }).toString();
    const ws = this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.token}` } });
    ws.on('open', () => {
      this.connected = true; this.attempt = 0; this.frame = 0; this.lastSeq = 0; this.frameSentAt = new Map(); this.uploadRTT = null; this.action = { action: 'idle', pan: 0, tilt: 0, expression: 'neutral' }; this.gestureUntil = 0;
      this.notify({ type: 'sim_connected', device_id: this.id });
      this.status(); this.sendFrame();
      this.frameTimer = setInterval(() => this.sendFrame(), 1000 / this.fps);
      this.statusTimer = setInterval(() => this.status(), 5000);
    });
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const m = parseDeviceServerMessage(raw.toString());
      if (!m) { this.notify({ type: 'sim_error', device_id: this.id, data: { message: 'Invalid BE message; ignored' } }); return; }
      if (m.type === 'frame_received') {
        const sent = this.frameSentAt.get(m.data.frame_id);
        if (sent !== undefined) { this.uploadRTT = Math.round(performance.now() - sent); this.frameSentAt.delete(m.data.frame_id); }
      } else if (m.type === 'action') {
        const a = m.data;
        if (!Number.isInteger(a.seq) || a.seq <= this.lastSeq) return;
        this.lastSeq = a.seq;
        const accepted = Date.now() >= this.gestureUntil;
        ws.send(serializeClient({ type: 'action_ack', timestamp: Date.now(), data: { seq: a.seq, accepted } }));
        if (!accepted) return;
        this.action = a;
        if (['happy', 'nod', 'shake'].includes(a.action)) this.gestureUntil = Date.now() + a.duration_ms;
        this.notify({ ...m, device_id: this.id });
      } else if (m.type === 'error') this.notify({ ...m, device_id: this.id });
    });
    ws.on('unexpected-response', (_, res) => { this.notify({ type: 'sim_error', device_id: this.id, data: { message: `Handshake HTTP ${res.statusCode}` } }); res.resume(); ws.emit('close', 1008); });
    ws.on('error', error => this.notify({ type: 'sim_error', device_id: this.id, data: { message: error instanceof Error ? error.message : 'Simulator error' } }));
    ws.on('close', code => {
      clearInterval(this.frameTimer); clearInterval(this.statusTimer); this.connected = false;
      this.action = { action: 'idle', pan: 0, tilt: 0, expression: 'neutral' };
      this.notify({ type: 'sim_disconnected', device_id: this.id, data: { code } });
      if (!this.stopped && ![1000, 1008, 1009, 4001].includes(code) && this.attempt < 3) {
        this.retry = setTimeout(() => this.start(), Math.min(10000, 1000 * 2 ** this.attempt++) + Math.random() * 300);
      }
    });
  }
  async sendFrame() {
    if (!this.connected || !this.ws || this.sending || this.ws.bufferedAmount > 256 * 1024) return;
    this.sending = true;
    try {
      const socket = this.ws;
      const frame = this.frame++ >>> 0;
      const jpeg = this.cameraJPEG || (this.files.length ? await readFile(this.files[frame % this.files.length]) : await syntheticJPEG(frame, this.sharedImage ? 'shared-scene' : this.id));
      if (jpeg.length + 4 > 256 * 1024) throw new Error('JPEG exceeds 256 KiB; reduce image dimensions/quality');
      const payload = Buffer.allocUnsafe(4 + jpeg.length); payload.writeUInt32BE(frame); jpeg.copy(payload, 4);
      if (this.ws === socket && socket.readyState === WebSocket.OPEN) { this.frameSentAt.set(frame, performance.now()); if (this.frameSentAt.size > 16) this.frameSentAt.delete(this.frameSentAt.keys().next().value ?? 0); socket.send(payload); }
      this.notify({ type: 'sim_frame', device_id: this.id, data: { frame_id: frame, source: this.cameraJPEG ? 'camera' : this.files.length ? 'files' : 'synthetic' } });
    } catch (error) { this.notify({ type: 'sim_error', device_id: this.id, data: { message: error instanceof Error ? error.message : 'Simulator error' } }); }
    finally { this.sending = false; }
  }
  status() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(serializeClient({ type: 'device_status', timestamp: Date.now(), data: { online: true, fps: this.fps, wifi_rssi: null, battery: null, transport: { upload_rtt_ms: this.uploadRTT }, current_action: ['happy', 'nod', 'shake'].includes(this.action.action) && Date.now() >= this.gestureUntil ? 'idle' : this.action.action } }));
  }
  async restart() {
    const previous = this.ws;
    this.stop();
    if (previous && previous.readyState !== WebSocket.CLOSED) await new Promise(resolve => {
      const timeout = setTimeout(() => { previous.terminate(); resolve(undefined); }, 1500);
      previous.once('close', () => { clearTimeout(timeout); resolve(undefined); });
    });
    this.stopped = false; this.start();
  }
  stop() { this.stopped = true; clearTimeout(this.retry); clearInterval(this.frameTimer); clearInterval(this.statusTimer); this.ws?.close(1000); }
}

/** @param {Map<string, Simulator>} simulators */
export function startGateway(simulators, { port = 8790, origin = 'http://127.0.0.1:8787' } = {}) {
  /** @type {Set<WebSocket>} */ const monitors = new Set(); let restarting = false;
  const server = createServer((_, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.headers.origin !== origin || !['/monitor', '/camera'].includes(url.pathname) || (url.pathname === '/camera' && !simulators.has(url.searchParams.get('device_id') || ''))) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      if (url.pathname === '/monitor') {
        monitors.add(ws); ws.send(JSON.stringify({ type: 'sim_snapshot', data: [...simulators.values()].map(s => ({ device_id: s.id, connected: s.connected, action: s.action })) }));
        ws.on('close', () => monitors.delete(ws));
        ws.on('message', async (raw, binary) => {
          if (binary || raw.toString().length > 256 || restarting) return;
          let value; try { value = JSON.parse(raw.toString()); } catch { return; }
          if (value.type !== 'restart_demo') return;
          restarting = true;
          try { await Promise.all([...simulators.values()].map(sim => sim.restart())); }
          finally { restarting = false; if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'demo_restarted' })); }
        });
      } else {
        const sim = simulators.get(url.searchParams.get('device_id') || '');
        if (!sim) { ws.close(1008); return; }
        if (sim.cameraPeer) sim.cameraPeer.close(4001, 'replaced'); sim.cameraPeer = ws;
        ws.on('message', (raw, binary) => {
          const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(new Uint8Array(raw));
          if (sim.cameraPeer === ws && binary && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) sim.cameraJPEG = bytes;
        });
        ws.on('close', () => { if (sim.cameraPeer === ws) { sim.cameraPeer = null; sim.cameraJPEG = null; } });
      }
    });
  });
  server.listen(port, '127.0.0.1');
  /** @param {SimulatorEvent} event */
  const notify = (event) => { for (const ws of monitors) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(JSON.stringify(event)); };
  return { notify, close() { for (const ws of wss.clients) ws.close(1000); wss.close(); server.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  /** @param {string} key */
  const option = key => { const i = process.argv.indexOf(`--${key}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  /** @type {string[]} */ let files = [];
  const image = option('image'); if (image) files = [resolve(image)];
  const framesDirectory = option('frames');
  if (framesDirectory) files = (await readdir(framesDirectory)).filter(p => /\.jpe?g$/i.test(p)).sort().map(p => resolve(framesDirectory, p));
  if (option('frames') && !files.length) throw new Error('No JPEG files in --frames directory');
  const token = process.env.DEVICE_TOKEN;
  if (!token) throw new Error('Set DEVICE_TOKEN in the environment; do not place tokens in command-line arguments');
  const sim = new Simulator({ base: option('base'), room: option('room'), id: option('device'), token, fps: Number(option('fps') || 60), files, notify: event => { if (event.type !== 'sim_frame') console.log(JSON.stringify(event)); } });
  sim.start(); process.on('SIGINT', () => sim.stop()); process.on('SIGTERM', () => sim.stop());
}
