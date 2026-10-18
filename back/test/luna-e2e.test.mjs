import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { syntheticRawPacket } from '../scripts/fw-simulator.mjs';
import { prepareOpenAIConfig } from '../scripts/local-env.mjs';
const base = 'http://127.0.0.1:8792', origin = 'http://127.0.0.1:8787';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const active = new Set(); let worker, fixture, output = '';
async function records(room) { return (await fetch(`${base}/__test/requests?room=${room}`)).json(); }
async function until(predicate, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { const result = await predicate(); if (result) return result; await sleep(30); } throw new Error('Timed out waiting for test condition'); }
async function connect(room, id, device = false) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${device ? 'device' : 'viewer'}?room=${room}&device_id=${id}`, { headers: device ? { Authorization: `Bearer token-${id}` } : { Origin: origin } });
  active.add(ws); const messages = []; let stream; let lastMetricsRequest=0;
  ws.on('message', (raw, binary) => {
    const m = binary ? Buffer.from(raw) : JSON.parse(raw); messages.push(m);
    if (m.type==='telemetry' && m.data.pipeline_total>0 && Date.now()-lastMetricsRequest>=1000) { lastMetricsRequest=Date.now(); ws.send(JSON.stringify({type:'telemetry_request',timestamp:Date.now(),data:{}})); }
    if (m.type === 'stream') stream = m.data.stream_id;
    if (binary && stream) ws.send(JSON.stringify({ timestamp: Date.now(), type: 'frame_ack', data: { stream_id: stream, frame_id: raw.readUInt32BE() } }));
  });
  await once(ws, 'open');
  return { ws, messages, wait: (predicate, ms) => until(() => messages.find(predicate), ms) };
}
async function pump(peers) {
  let frameId = 0;
  const send = async () => {
    const id = frameId++;
    for (const peer of peers) {
      const bytes = await syntheticRawPacket(id);
      if (peer.ws.readyState === 1) { peer.ws.send(bytes); peer.ws.send(JSON.stringify({ timestamp: Date.now(), type: 'device_status', data: { online: true, fps: 2, wifi_rssi: null, battery: null, current_action: 'idle' } })); }
    }
  };
  await send(); const timer = setInterval(() => send().catch(() => {}), 500); return () => clearInterval(timer);
}
async function startWorker() {
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', `${fixture}/wrangler.jsonc`, '--ip', '127.0.0.1', '--port', '8792', '--inspector-port', '9232', '--persist-to', `${fixture}/state`], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs/luna-e2e.log' } });
  worker.stdout.on('data', d => output += d); worker.stderr.on('data', d => output += d);
  try { await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 30000); } catch { throw new Error(output); }
}
before(async () => {
  await mkdir('.wrangler', { recursive: true });
  const cfg = JSON.parse(await readFile('wrangler.local.jsonc', 'utf8'));
  delete cfg.$schema; cfg.name = 'stackchan-luna-e2e'; cfg.main = resolve('test/fixtures/luna-worker.ts'); cfg.assets.directory = resolve('lab'); cfg.vars.AI_MODE = 'decisions';
  // Generation-count assertions require evaluations outside the 2s narration cooldown.
  cfg.vars.EVAL_INTERVAL_MS = '2000'; cfg.vars.BEHAVIOR_MODE = 'autonomous';
  const rooms = Object.fromEntries(['main', 'invalid', 'rate', 'timeout', 'slow', 'stale', 'self_stale', 'no_person', 'feelings', 'bad_emotion', 'sad_face', 'identity', 'random_identity', 'human_actions', 'low_intent'].map(room => [room, { profiles: room === 'random_identity' ? {} : { 'stackchan-01': 'curious', 'stackchan-02': 'shy' }, control_token: 'test-control', devices: { 'stackchan-01': 'token-stackchan-01', 'stackchan-02': 'token-stackchan-02' } }]));
  const prepared = await prepareOpenAIConfig({ ROOM_CONFIG: JSON.stringify(rooms), SESSION_SECRET: 'test-only-signing-secret', ALLOWED_ORIGIN: origin, OPENAI_API_KEY: 'fixture-not-a-real-key' }, { seconds: 600, maxCalls: 1000 });
  fixture = prepared.path.slice(0, prepared.path.lastIndexOf('/'));
  await writeFile(`${fixture}/wrangler.jsonc`, JSON.stringify(cfg));
  await startWorker();
});
after(async () => {
  for (const ws of active) ws.close(1000);
  if (worker) { const exited = once(worker, 'exit'); worker.kill('SIGTERM'); await Promise.race([exited, sleep(3000)]); }
  if (fixture) await rm(fixture, { recursive: true, force: true });
});
test('Responses-generated private thoughts and public dialogue reach the correct recipients and physical actions stay constrained', async () => {
  const a = await connect('main', 'stackchan-01', true), b = await connect('main', 'stackchan-02', true);
  const va = await connect('main', 'stackchan-01'), vb = await connect('main', 'stackchan-02');
  const stop = await pump([a, b]);
  try {
    const greeting = (await va.wait(x => x.type === 'dialogue' && x.data.speech_act === 'greet')).data;
    assert.equal(greeting.text, '笑顔が見えたよ。一緒に見よう！');
    const reply = (await vb.wait(x => x.type === 'dialogue' && x.data.reply_to === greeting.id, 10000)).data;
    assert.equal(reply.text, '…うん、ありがとう。');
    const mind = (await vb.wait(x => x.type === 'mind' && x.data.cause.message_id === greeting.id)).data;
    assert.match(mind.thought, /stackchan-02だけの本音/); assert.equal(mind.generation.provider, 'openai'); assert.equal(mind.generation.model, 'gpt-6-luna');
    const outward = (await vb.wait(x => x.type === 'behavior' && x.data?.mind_revision === mind.revision)).data;
    assert.equal(outward.command.expression, 'neutral'); assert.equal(outward.command.action, 'nod');
    assert.deepEqual((await b.wait(x => x.type === 'action' && x.data.seq === outward.command.seq)).data, outward.command);
    await va.wait(x => x.type === 'mind' && x.data.cause.message_id === reply.id, 10000);
    const calls = await records('main'), texts = calls.filter(r => r.endpoint === 'responses');
    const images = calls.flatMap(r => r.body.input?.[0]?.content || []).filter(c => c.type === 'input_image');
    assert.ok(images.length > 0);
    for (const image of images) {
      assert.match(image.image_url, /^data:image\/jpeg;base64,/);
      const bytes = Buffer.from(image.image_url.split(',')[1], 'base64');
      assert.equal(bytes.readUInt16BE(), 0xffd8); assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9);
    }
    const choices = texts.map(r => JSON.parse(r.body.input[1].content).selected_choice);
    for (const type of ['greet:', 'reply:', 'listen:']) assert.equal(choices.filter(c => c.startsWith(type)).length, 1, `one ${type} generation`);
    assert.ok(texts.filter(r => !JSON.parse(r.body.input[1].content).human_action).length <= 4, 'ordinary reactions remain bounded; new human events are counted separately');
    for (const request of texts) {
      const ctx = JSON.parse(request.body.input[1].content), encoded = JSON.stringify(ctx);
      const other = ctx.self.device_id === 'stackchan-01' ? 'stackchan-02' : 'stackchan-01';
      assert.ok(!encoded.includes(`${other}だけの本音`), 'peer private text must never enter generation input');
      assert.ok(ctx.visible_peers.every(p => !('mind' in p) && !('emotion' in p) && !('thought' in p)));
      assert.equal(request.body.store, false); assert.equal(request.body.model, 'gpt-6-luna');
    }
    assert.ok(texts.some(r => JSON.parse(r.body.input[1].content).received_utterance?.text === greeting.text), 'generated public speech feeds the recipient generation');
    assert.ok(!JSON.stringify(reply).includes('だけの本音'));
    for (const fw of [a, b]) assert.ok(!fw.messages.some(x => ['mind', 'dialogue', 'behavior'].includes(x.type)));
    const decision = await vb.wait(x => x.type === 'decision' && x.data.ai?.calls.some(c => c.endpoint === 'responses'));
    assert.equal(decision.data.ai.output_tokens, 60);
    const timing = (await vb.wait(m=>m.type==='telemetry_snapshot' && m.data.samples.api.some(a=>a.stage==='narration' && a.outcome==='success'))).data;
    assert.ok(timing.samples.api.some(a=>a.stage==='perception'));assert.ok(timing.samples.api.some(a=>a.stage==='intention'));
    assert.ok(timing.samples.api.every(a=>a.rtt_ms>=0 && !('input' in a) && !('body' in a)));
    await sleep(2500); assert.equal(va.messages.filter(x => x.type === 'dialogue').length, 2, 'no reply loop');
    assert.equal((await records('main')).filter(r => r.endpoint === 'responses').length, texts.length, 'held intention does not generate per frame');
  } finally { stop(); for (const p of [a, b, va, vb]) p.ws.close(1000); }
});
for (const [room, reason] of [['invalid', 'api_error'], ['rate', 'rate_limit'], ['timeout', 'api_error']]) test(`${room}: fall back visibly, deliver safe motion and avoid generation retry storm`, async () => {
  const fw = await connect(room, 'stackchan-02', true), view = await connect(room, 'stackchan-02'), stop = await pump([fw]);
  try {
    const mind = (await view.wait(x => x.type === 'mind' && x.data.generation?.provider === 'fallback', 8000)).data;
    assert.equal(mind.generation.reason, reason); assert.equal(mind.generation.model, null);
    const behavior = (await view.wait(x => x.type === 'behavior' && x.data?.mind_revision === mind.revision)).data;
    assert.equal(behavior.command.pan, .35); await fw.wait(x => x.type === 'action');
    assert.ok(!JSON.stringify(view.messages).includes('NOT_FOR_CLIENTS'));
    const timing = (await view.wait(m=>m.type==='telemetry_snapshot' && m.data.samples.api.some(a=>a.stage==='narration' && a.outcome!=='success'))).data;
    const failure=timing.samples.api.find(a=>a.stage==='narration' && a.outcome!=='success');
    assert.equal(failure.outcome,room==='rate'?'http_error':room==='timeout'?'timeout':'invalid_response');
    assert.ok(!JSON.stringify(timing).includes('NOT_FOR_CLIENTS'));
    await sleep(6500);
    assert.equal((await records(room)).filter(r => r.endpoint === 'responses').length, 1);
    assert.ok(view.messages.filter(Buffer.isBuffer).length >= 10, 'video relay stays live');
  } finally { stop(); fw.ws.close(1000); view.ws.close(1000); }
});
test('delayed generation allows video and detection control while awaiting a bounded response', async () => {
  const fw = await connect('slow', 'stackchan-01', true), view = await connect('slow', 'stackchan-01');
  const stream = (await view.wait(x => x.type === 'stream')).data.stream_id, stop = await pump([fw]);
  let controller;
  try {
    await until(async () => (await records('slow')).some(r => r.endpoint === 'responses'));
    const before = view.messages.filter(Buffer.isBuffer).length;
    const login = await fetch(`${base}/api/control/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'slow', token: 'test-control' }) });
    controller = new WebSocket(`${base.replace('http', 'ws')}/ws/viewer?room=slow&device_id=stackchan-01&control=1`, { headers: { Origin: origin, Cookie: login.headers.get('set-cookie').split(';')[0] } });
    controller.on('message', () => {}); await once(controller, 'open');
    const latest = view.messages.filter(Buffer.isBuffer).at(-1).readUInt32BE();
    controller.send(JSON.stringify({ timestamp: Date.now(), type: 'detection', data: { stream_id: stream, frame_id: latest, faces: [{ id: 0, x: .7, y: .1, width: .2, height: .3, confidence: .99 }], primary_face_id: 0 } }));
    await fw.wait(x => x.type === 'action' && x.data.pan < 0);
    await view.wait(x => x.type === 'mind' && x.data.generation?.provider === 'openai');
    assert.ok(view.messages.filter(Buffer.isBuffer).length > before);
  } finally { stop(); controller?.close(1000); fw.ws.close(1000); view.ws.close(1000); }
});
test('peer reconnect during generation discards the old greeting', async () => {
  const a = await connect('stale', 'stackchan-01', true), b = await connect('stale', 'stackchan-02', true), view = await connect('stale', 'stackchan-01');
  const stop = await pump([a]); let b2;
  try {
    await until(async () => (await records('stale')).some(r => r.endpoint === 'responses'));
    b2 = await connect('stale', 'stackchan-02', true);
    await sleep(1800);
    assert.ok(!view.messages.some(x => x.type === 'dialogue'), 'old target stream must not receive generated speech');
    assert.ok(!view.messages.some(x => x.type === 'mind' && x.data.generation?.provider === 'openai'));
  } finally { stop(); for (const p of [a, b, b2, view]) p?.ws.close(1000); }
});
test('own reconnect discards generated text from the previous stream and can generate again', async () => {
  const fw = await connect('self_stale', 'stackchan-01', true), view = await connect('self_stale', 'stackchan-01');
  const oldStream = (await view.wait(x => x.type === 'stream')).data.stream_id, stop = await pump([fw]); let replacement, stopNew;
  try {
    await until(async () => (await records('self_stale')).some(r => r.endpoint === 'responses'));
    stop(); replacement = await connect('self_stale', 'stackchan-01', true);
    await view.wait(x => x.type === 'stream' && x.data.stream_id && x.data.stream_id !== oldStream);
    const offset = view.messages.length;
    await sleep(1800);
    assert.ok(!view.messages.slice(offset).some(x => x.type === 'mind' && x.data.generation?.provider === 'openai'));
    assert.ok(!replacement.messages.some(x => x.type === 'action'));
    stopNew = await pump([replacement]);
    await view.wait(x => x.type === 'mind' && x.data.generation?.provider === 'openai', 6000);
  } finally { stop(); stopNew?.(); for (const p of [fw, replacement, view]) p?.ws.close(1000); }
});
test('two robots generate a greeting and reply even when Decisions detects no human', async () => {
  const a = await connect('no_person', 'stackchan-01', true), b = await connect('no_person', 'stackchan-02', true);
  const view = await connect('no_person', 'stackchan-01'), stop = await pump([a, b]);
  try {
    const greeting = (await view.wait(x => x.type === 'dialogue' && x.data.speech_act === 'greet')).data;
    assert.equal(greeting.text, '少しお話ししない？');
    await view.wait(x => x.type === 'dialogue' && x.data.reply_to === greeting.id, 10000);
    const calls = await records('no_person');
    const request = calls.find(r => r.endpoint === 'responses' && JSON.parse(r.body.input[1].content).selected_choice.startsWith('greet:'));
    assert.equal(JSON.parse(request.body.input[1].content).observations.person_present, 0);
    const decision = await view.wait(x => x.type === 'decision' && x.data.intent === 'greet');
    assert.equal(decision.data.observations.person_present, 0, 'no fabricated person detection');
  } finally { stop(); for (const p of [a, b, view]) p.ws.close(1000); }
});
test('identical images reach personal score questions and different model feelings are committed unchanged', async () => {
  const a = await connect('feelings', 'stackchan-01', true), b = await connect('feelings', 'stackchan-02', true);
  const va = await connect('feelings', 'stackchan-01'), vb = await connect('feelings', 'stackchan-02'), stop = await pump([a, b]);
  try {
    const da = await va.wait(x => x.type === 'decision'), db = await vb.wait(x => x.type === 'decision');
    for (const [view, decision, expectedShyness] of [[va, da, .15], [vb, db, .85]]) {
      assert.equal(decision.data.affect.provider, 'openai');
      const previous = view.messages.slice(0, view.messages.indexOf(decision)).filter(x => x.type === 'emotion').at(-1).data;
      assert.equal(previous.shyness, expectedShyness); assert.equal(previous.happiness, .7);
    }
    const calls = await records('feelings'), evaluations = calls.filter(r => r.body.questions?.some(q => q.type === 'score'));
    const firstA = evaluations.find(r => JSON.parse(r.body.input[0].content[0].text.split('\n').at(-1)).robot_context.self.device_id === 'stackchan-01');
    const firstB = evaluations.find(r => JSON.parse(r.body.input[0].content[0].text.split('\n').at(-1)).robot_context.self.device_id === 'stackchan-02');
    assert.equal(firstA.body.input[0].content[1].image_url, firstB.body.input[0].content[1].image_url);
    await until(async () => (await records('feelings')).some(r => r.body.questions?.some(q => q.type === 'score') && JSON.parse(r.body.input[0].content[0].text.split('\n').at(-1)).own_affective_history.length > 0));
    for (const r of (await records('feelings')).filter(r => r.body.questions?.some(q => q.type === 'score'))) {
      const ctx = JSON.parse(r.body.input[0].content[0].text.split('\n').at(-1));
      const other = ctx.robot_context.self.device_id === 'stackchan-01' ? 'stackchan-02' : 'stackchan-01';
      assert.ok(!JSON.stringify(ctx).includes(`${other}だけの本音`));
      assert.ok(ctx.own_affective_history.length <= 6);
    }
  } finally { stop(); for (const p of [a, b, va, vb]) p.ws.close(1000); }
});
test('a refused emotional score preserves all five feelings and issues no new motion', async () => {
  const fw = await connect('bad_emotion', 'stackchan-01', true), view = await connect('bad_emotion', 'stackchan-01'), stop = await pump([fw]);
  try {
    const initial = (await view.wait(x => x.type === 'emotion')).data;
    await view.wait(x => x.type === 'error' && x.data.code === 'ai_unavailable');
    assert.deepEqual(view.messages.filter(x => x.type === 'emotion').at(-1).data, initial);
    assert.ok(!view.messages.some(x => x.type === 'decision')); assert.ok(!fw.messages.some(x => x.type === 'action'));
  } finally { stop(); fw.ws.close(1000); view.ws.close(1000); }
});
test('sad-looking facial display and visible tears are reported beyond smiling', async () => {
  const fw = await connect('sad_face', 'stackchan-01', true), view = await connect('sad_face', 'stackchan-01'), stop = await pump([fw]);
  try {
    const decision = (await view.wait(x => x.type === 'decision')).data;
    assert.equal(decision.observations.apparent_expression.label, 'sad_looking'); assert.equal(decision.observations.tears_visible, .9);
    assert.ok(decision.observations.smiling < .5); assert.equal(decision.affect.provider, 'openai');
  } finally { stop(); fw.ws.close(1000); view.ws.close(1000); }
});

test('unconfigured personalities are assigned only on first authenticated participation and survive replacement', async () => {
  const allowed = ['curious', 'shy', 'cheerful', 'calm', 'cautious', 'playful'];
  const viewer = await connect('random_identity', 'stackchan-01');
  assert.equal((await viewer.wait(m => m.type === 'memory')).data.first_join_at, null, 'viewing does not assign an identity');
  const fw = await connect('random_identity', 'stackchan-01', true);
  const first = (await viewer.wait(m => m.type === 'memory' && m.data.first_join_at !== null)).data;
  const stream = (await viewer.wait(m => m.type === 'stream' && m.data.stream_id)).data.stream_id;
  const state = await connect('random_identity', 'stackchan-01');
  const mind = (await state.wait(m => m.type === 'mind')).data;
  assert.ok(allowed.includes(mind.personality));
  const replacement = await connect('random_identity', 'stackchan-01', true);
  await viewer.wait(m => m.type === 'stream' && m.data.stream_id && m.data.stream_id !== stream);
  const resumed = await connect('random_identity', 'stackchan-01');
  assert.equal((await resumed.wait(m => m.type === 'mind')).data.personality, mind.personality);
  assert.equal((await resumed.wait(m => m.type === 'memory')).data.first_join_at, first.first_join_at);
  for (const p of [viewer, fw, state, replacement, resumed]) p.ws.close(1000);
});

test('new human gestures interrupt the held intention, differ by personality and experience, and never repeat for a sustained pose', async () => {
  const room = 'human_actions', a = await connect(room, 'stackchan-01', true), b = await connect(room, 'stackchan-02', true);
  const va = await connect(room, 'stackchan-01'), vb = await connect(room, 'stackchan-02');
  const stop = await pump([a,b]);
  const scene = name => fetch(`${base}/__test/scene?room=${room}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body:JSON.stringify({scene:name}) });
  const hand = m => m.type === 'decision' && m.data.human_action?.changes.includes('hand_raised');
  try {
    await va.wait(m => m.type === 'decision' && m.data.human_action?.changes.includes('person_appeared'));
    await vb.wait(m => m.type === 'decision' && m.data.human_action?.changes.includes('person_appeared'));
    const previous = va.messages.filter(m => m.type === 'mind').at(-1).data;
    await scene('raised');
    const da = (await va.wait(hand,8000)).data, db = (await vb.wait(hand,8000)).data;
    assert.ok(va.messages.find(m => m.type === 'human_action' && m.data.id === da.human_action.id).timestamp < previous.valid_until, 'new human event interrupts the six-second hold');
    assert.equal(da.intent,'delight'); assert.equal(db.intent,'avert');
    assert.equal(da.reaction.intent_reassessed,true);assert.equal(da.reaction.command_issued,true);
    const ca = (await va.wait(m => m.type === 'behavior' && m.data?.mind_revision === da.mind_revision)).data.command;
    const cb = (await vb.wait(m => m.type === 'behavior' && m.data?.mind_revision === db.mind_revision)).data.command;
    assert.equal(ca.action,'happy');assert.equal(cb.action,'look_at');assert.equal(cb.pan,.35);
    await a.wait(m => m.type === 'action' && m.data.seq === ca.seq);await b.wait(m => m.type === 'action' && m.data.seq === cb.seq);
    const count = a.messages.filter(m => m.type === 'action').length;
    await sleep(8500);
    assert.equal(va.messages.filter(hand).length,1,'one decision consumes one gesture event');
    assert.equal(a.messages.filter(m => m.type === 'action').length,count,'same pose does not repeat a gesture even after the hold expires');
    assert.ok(va.messages.some(m => m.type === 'decision' && m.timestamp > previous.valid_until && m.data.reaction.trigger === 'periodic' && !m.data.reaction.command_issued));
    const neutralStart = vb.messages.length; await scene('neutral');
    await until(()=>vb.messages.slice(neutralStart).filter(m=>m.type==='decision' && m.data.observations.waving<=.3).length>=2,10000);
    await scene('raised');
    const second = (await vb.wait(m => hand(m) && m.data.human_action.id !== db.human_action.id,8000)).data;
    assert.equal(second.intent,'acknowledge_person','the same shy robot responds differently after its prior experience');
    const nod = (await vb.wait(m => m.type === 'behavior' && m.data?.mind_revision === second.mind_revision)).data.command;
    assert.equal(nod.action,'nod');await b.wait(m => m.type === 'action' && m.data.seq === nod.seq);
    const calls = await records(room), choices = calls.filter(r => r.endpoint === 'decisions' && r.body.questions[0].name === 'intention');
    const contexts = choices.map(r => JSON.parse(r.body.input));
    assert.ok(contexts.some(c => c.human_action?.id === second.human_action.id && c.own_affective_history.some(e => e.human_action?.id === db.human_action.id)));
    assert.ok(contexts.every(c => !JSON.stringify(c.visible_peers).includes('だけの本音')));
  } finally {stop();for(const p of [a,b,va,vb])p.ws.close(1000);}
});

test('valid low-confidence fictional intentions still publish their observations and constrained action', async () => {
  const fw = await connect('low_intent', 'stackchan-01', true), view = await connect('low_intent', 'stackchan-01');
  const stop = await pump([fw]);
  try {
    const decision = (await view.wait(m => m.type === 'decision')).data;
    assert.equal(decision.confidence, .2); assert.equal(decision.observations.person_present, .9);
    assert.equal(decision.affect.provider, 'openai');
    const behavior = (await view.wait(m => m.type === 'behavior' && m.data?.mind_revision === decision.mind_revision)).data;
    assert.ok(['idle','look_at','nod','shake','happy'].includes(behavior.command.action));
    await fw.wait(m => m.type === 'action' && m.data.seq === behavior.command.seq);
  } finally { stop(); fw.ws.close(1000); view.ws.close(1000); }
});

test('personal emotion, thought, experience and relationship memory survive reconnect and a Worker process restart', async () => {
  const a = await connect('identity', 'stackchan-01', true), b = await connect('identity', 'stackchan-02', true);
  const va = await connect('identity', 'stackchan-01'), vb = await connect('identity', 'stackchan-02');
  const stop = await pump([a, b]);
  await vb.wait(m => m.type === 'memory' && m.data.total_experiences >= 2, 10000);
  stop(); await sleep(150);
  const snapshot = await connect('identity', 'stackchan-02');
  const mind = (await snapshot.wait(m => m.type === 'mind')).data;
  const emotion = (await snapshot.wait(m => m.type === 'emotion')).data;
  const memory = (await snapshot.wait(m => m.type === 'memory')).data;
  assert.ok(mind.relationships['stackchan-01'] > .5, 'a public interaction was remembered');
  assert.ok(memory.experience_count >= 2);
  const oldStream = (await snapshot.wait(m => m.type === 'stream')).data.stream_id;
  b.ws.close(1000); await vb.wait(m => m.type === 'stream' && m.data.stream_id === null);
  const reconnected = await connect('identity', 'stackchan-02', true);
  const check = await connect('identity', 'stackchan-02');
  const same = (await check.wait(m => m.type === 'mind')).data;
  assert.equal(same.personality, mind.personality); assert.equal(same.thought, mind.thought);
  assert.deepEqual(same.relationships, mind.relationships);
  assert.deepEqual((await check.wait(m => m.type === 'emotion')).data, emotion);
  assert.equal((await check.wait(m => m.type === 'memory')).data.total_experiences, memory.total_experiences);
  assert.notEqual((await check.wait(m => m.type === 'stream')).data.stream_id, oldStream);
  assert.equal((await check.wait(m => m.type === 'behavior')).data, null, 'old motion is never replayed');
  for (const ws of active) ws.close(1000);
  const exited = once(worker, 'exit'); worker.kill('SIGTERM'); await exited;
  await startWorker();
  const restoredFW = await connect('identity', 'stackchan-02', true), restored = await connect('identity', 'stackchan-02');
  const restoredMind = (await restored.wait(m => m.type === 'mind')).data;
  assert.equal(restoredMind.personality, mind.personality); assert.equal(restoredMind.thought, mind.thought);
  assert.deepEqual(restoredMind.relationships, mind.relationships);
  assert.deepEqual((await restored.wait(m => m.type === 'emotion')).data, emotion);
  const restoredTiming = (await restored.wait(m=>m.type==='telemetry_snapshot')).data; assert.ok(restoredTiming.pipeline_total>0);assert.ok(restoredTiming.samples.api.length>0);
  const restoredMemory = (await restored.wait(m => m.type === 'memory')).data;
  assert.equal(restoredMemory.first_join_at, memory.first_join_at);
  assert.equal(restoredMemory.total_experiences, memory.total_experiences);
  assert.equal((await restored.wait(m => m.type === 'behavior')).data, null);
  const bytes = await syntheticRawPacket(0); restoredFW.ws.send(bytes);
  await restored.wait(m => m.type === 'decision');
  const evaluation = (await records('identity')).find(r => r.endpoint === 'decisions' && r.body.questions[0].type === 'predicate');
  const context = JSON.parse(evaluation.body.input[0].content[0].text.split('\n').at(-1));
  assert.equal(context.own_affective_history.length, memory.experience_count);
  assert.deepEqual(context.robot_context.self.emotion, emotion);
  assert.equal(context.robot_context.self.previous_thought, mind.thought);
  assert.ok(context.robot_context.public_history.length >= 1);
  restoredFW.ws.close(1000); restored.ws.close(1000);
});
