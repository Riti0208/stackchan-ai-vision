import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { syntheticJPEG, Simulator, startGateway } from '../scripts/fw-simulator.mjs';
const base = 'http://127.0.0.1:8789', origin = 'http://127.0.0.1:8787';
const active = new Set(); let worker, workerLog = '', cookie, otherCookie, fixture;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = (type, data) => JSON.stringify({ type, timestamp: Date.now(), data });
async function login(token = 'dev-control-main') {
  const res = await fetch(`${base}/api/control/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'main', token }) });
  assert.equal(res.status, 200); return res.headers.get('set-cookie').split(';')[0];
}
async function connect(id, role = 'viewer', token = '', room = 'main') {
  const device = role === 'device';
  const url = `${base.replace('http', 'ws')}/ws/${device ? 'device' : 'viewer'}?room=${encodeURIComponent(room)}&device_id=${id}${role === 'controller' ? '&control=1' : ''}`;
  const headers = device ? { Authorization: `Bearer ${token}` } : { Origin: origin, ...(token ? { Cookie: token } : {}) };
  const ws = new WebSocket(url, { headers }); active.add(ws);
  const messages = []; let stream; let lastMetricsRequest=0;
  ws.on('message', (raw, binary) => {
    const value = binary ? Buffer.from(raw) : JSON.parse(raw.toString());
    messages.push(value);
    if (value.type==='telemetry' && value.data.pipeline_total>0 && Date.now()-lastMetricsRequest>=1000) { lastMetricsRequest=Date.now(); ws.send(env('telemetry_request',{})); }
    if (!binary && value.type === 'stream') stream = value.data.stream_id;
    if (binary && role !== 'device' && stream) ws.send(env('frame_ack', { stream_id: stream, frame_id: raw.readUInt32BE() }));
  });
  await once(ws, 'open');
  return { ws, messages, send(type, data) { ws.send(env(type, data)); }, async wait(predicate, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = messages.find(predicate); if (value) return value; await sleep(20); } throw new Error(`Timed out: ${messages.filter(x => !Buffer.isBuffer(x)).map(x => JSON.stringify(x)).join('\n')}`); } };
}
async function rejected(path, headers, status) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers });
  await new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_, res) => { try { assert.equal(res.statusCode, status); res.resume(); ws.terminate(); resolve(); } catch (error) { reject(error); } });
    ws.on('open', () => { ws.close(); reject(new Error('Unexpected authorization success')); }); ws.on('error', () => {});
  });
}
async function frame(peer, id, device = 'stackchan-01') {
  const jpeg = await syntheticJPEG(id, device), packet = Buffer.alloc(4 + jpeg.length); packet.writeUInt32BE(id); jpeg.copy(packet, 4); peer.ws.send(packet); return packet;
}
function detect(stream, id, x = .7) { return { stream_id: stream, frame_id: id, faces: [{ id: 0, x, y: .1, width: .2, height: .3, confidence: .99 }], primary_face_id: 0 }; }
before(async () => {
  await mkdir('.wrangler', { recursive: true }); fixture = await mkdtemp(resolve('.wrangler/e2e-'));
  const configuration = JSON.parse(await readFile('wrangler.local.jsonc', 'utf8'));
  configuration.main = resolve('src/index.ts'); configuration.assets.directory = resolve('lab'); configuration.name = 'stackchan-e2e'; delete configuration.$schema;
  await writeFile(`${fixture}/wrangler.jsonc`, JSON.stringify(configuration));
  const vars = await readFile('.dev.vars.example', 'utf8');
  const match = vars.match(/^ROOM_CONFIG='(.+)'$/m);
  const rooms = JSON.parse(match[1]); rooms.main.profiles = { 'stackchan-01': 'curious', 'stackchan-02': 'shy' }; rooms.isolated = { control_token: 'dev-control-isolated', devices: { 'stackchan-01': 'dev-isolated-01' } };
  await writeFile(`${fixture}/.dev.vars`, vars.replace(match[0], `ROOM_CONFIG='${JSON.stringify(rooms)}'`));
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', `${fixture}/wrangler.jsonc`, '--ip', '127.0.0.1', '--port', '8789', '--inspector-port', '9230', '--persist-to', `${fixture}/state`], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs/e2e.log' }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', d => workerLog += d); worker.stderr.on('data', d => workerLog += d);
  let ready = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {} await sleep(500); }
  assert.ok(ready, workerLog); cookie = await login(); otherCookie = await login();
});
after(async () => { for (const ws of active) ws.close(1000); if (worker) { const exited = once(worker, 'exit'); worker.kill('SIGTERM'); await Promise.race([exited, sleep(3000)]); } if (fixture) await rm(fixture, { recursive: true, force: true }); });

test('HTTP registration, device authentication, origin and control session', async () => {
  const list = await (await fetch(`${base}/api/rooms/main/devices`)).json();
  assert.deepEqual(list.devices.map(d => d.device_id), ['stackchan-01', 'stackchan-02']);
  assert.ok(list.devices.every(d => !d.online));
  assert.equal((await fetch(`${base}/api/rooms/unknown/devices`)).status, 404);
  await rejected('/ws/device?room=main&device_id=stackchan-01', { Authorization: 'Bearer bad' }, 401);
  await rejected('/ws/device?room=main&device_id=stackchan-01', { Authorization: 'Bearer dev-device-02' }, 401);
  await rejected('/ws/viewer?room=main&device_id=stackchan-01', { Origin: 'https://evil.example' }, 403);
  await rejected('/ws/viewer?room=main&device_id=stackchan-01&control=1', { Origin: origin }, 401);
  await rejected('/ws/viewer?room=main&device_id=stackchan-01&control=1', { Origin: origin, Cookie: cookie + 'tampered' }, 401);
});

test('two devices: exact JPEG relay, per-device control, mock decision and reconnect isolation', async () => {
  const a = await connect('stackchan-01', 'device', 'dev-device-01'), b = await connect('stackchan-02', 'device', 'dev-device-02');
  const va = await connect('stackchan-01', 'controller', cookie), vb = await connect('stackchan-02', 'controller', cookie);
  await va.wait(x => x.type === 'device_status'); await vb.wait(x => x.type === 'device_status');
  assert.deepEqual(va.messages.slice(0, 4).map(x => x.type), ['session', 'stream', 'emotion', 'device_status']);
  const stream = va.messages.find(x => x.type === 'stream').data.stream_id;
  assert.notEqual(stream, vb.messages.find(x => x.type === 'stream').data.stream_id);
  va.send('heartbeat', {}); await va.wait(x => x.type === 'heartbeat');
  const pa = await frame(a, 0), pb = await frame(b, 0, 'stackchan-02');
  assert.deepEqual(await va.wait(Buffer.isBuffer), pa); assert.deepEqual(await vb.wait(Buffer.isBuffer), pb); assert.notDeepEqual(pa, pb);
  va.send('detection', detect(stream, 0));
  const tracking = await a.wait(x => x.type === 'action' && x.data.action === 'look_at'); assert.ok(tracking.data.pan > 0); assert.ok(tracking.data.tilt > 0);
  assert.ok(!b.messages.some(x => x.type === 'action' && x.data.action === 'look_at'), 'A detection must not steer B');
  const decision = await va.wait(x => x.type === 'decision'); assert.equal(decision.data.stream_id, stream); assert.equal(decision.data.frame_id, 0);
  assert.ok(va.messages.some(x => x.type === 'emotion' && x.data.happiness > .5));
  await a.wait(x => x.type === 'action' && x.data.action === 'happy');
  await rejected('/ws/viewer?room=main&device_id=stackchan-01&control=1', { Origin: origin, Cookie: otherCookie }, 409);
  const duplicateClosed = once(va.ws, 'close'); const replacement = await connect('stackchan-01', 'controller', cookie);
  assert.equal((await duplicateClosed)[0], 4001);
  const closed = once(a.ws, 'close'); const a2 = await connect('stackchan-01', 'device', 'dev-device-01'); assert.equal((await closed)[0], 4001);
  const newStream = (await replacement.wait(x => x.type === 'stream' && x.data.stream_id !== stream)).data.stream_id;
  await frame(a2, 0); await replacement.wait(Buffer.isBuffer);
  replacement.send('detection', detect(stream, 0)); await sleep(80);
  assert.ok(!a2.messages.some(x => x.type === 'action'), 'Old stream detection must not be applied');
  replacement.send('detection', detect(newStream, 0));
  const firstAction = await a2.wait(x => x.type === 'action' && x.data.action === 'look_at'); assert.equal(firstAction.data.seq, 1);
  b.ws.close(1000); await vb.wait(x => x.type === 'device_status' && !x.data.online);
  const list = await (await fetch(`${base}/api/rooms/main/devices`)).json(); assert.deepEqual(list.devices.map(d => d.online), [true, false]);
  for (const peer of [a2, replacement, vb]) peer.ws.close(1000);
});

test('viewer cannot control; malformed detection is rejected without steering', async () => {
  await sleep(100);
  const a = await connect('stackchan-01', 'device', 'dev-device-01'), view = await connect('stackchan-01');
  await view.wait(x => x.type === 'stream');
  const closed = once(view.ws, 'close'); view.send('detection', detect('fake', 0)); assert.equal((await closed)[0], 1008);
  const control = await connect('stackchan-01', 'controller', cookie); const stream = (await control.wait(x => x.type === 'stream')).data.stream_id;
  const bad = detect(stream, 0); bad.faces[0].x = 2; control.send('detection', bad); await control.wait(x => x.type === 'error' && x.data.code === 'invalid_message');
  assert.ok(!a.messages.some(x => x.type === 'action'));
  control.ws.close(1000); a.ws.close(1000);
});

test('JPEG size limit and unsigned uint32 rollover', async () => {
  await sleep(100);
  const a = await connect('stackchan-02', 'device', 'dev-device-02'), viewer = await connect('stackchan-02');
  await viewer.wait(x => x.type === 'stream');
  await frame(a, 0xffffffff, 'stackchan-02'); await frame(a, 0, 'stackchan-02');
  await viewer.wait(x => Buffer.isBuffer(x) && x.readUInt32BE() === 0);
  assert.deepEqual(viewer.messages.filter(Buffer.isBuffer).map(x => x.readUInt32BE()), [0xffffffff, 0]);
  const closed = once(a.ws, 'close'); a.ws.send(Buffer.alloc(256 * 1024 + 1)); assert.equal((await closed)[0], 1009);
  viewer.ws.close(1000);
});


test('slow viewer is disconnected instead of growing an image backlog', async () => {
  await sleep(100);
  const device = await connect('stackchan-02', 'device', 'dev-device-02');
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/viewer?room=main&device_id=stackchan-02`, { headers: { Origin: origin } });
  active.add(ws); await once(ws, 'open'); const closed = once(ws, 'close');
  for (let id = 0; id < 5; id++) await frame(device, id, 'stackchan-02');
  assert.equal((await closed)[0], 1013);
  device.ws.close(1000);
});

test('missing status/heartbeat expires device and control leases and releases control', async () => {
  await sleep(100);
  const device = await connect('stackchan-01', 'device', 'dev-device-01');
  const controller = await connect('stackchan-01', 'controller', cookie);
  const deviceClosed = once(device.ws, 'close'), controlClosed = once(controller.ws, 'close');
  const result = await Promise.race([Promise.all([deviceClosed, controlClosed]), sleep(18000).then(() => { throw new Error('Status/heartbeat timeout was not enforced'); })]);
  assert.deepEqual(result.map(x => x[0]), [4000, 4000]);
  const takeover = await connect('stackchan-01', 'controller', otherCookie);
  const status = await takeover.wait(x => x.type === 'device_status'); assert.equal(status.data.online, false);
  takeover.ws.close(1000);
});


test('two robots exchange public utterances while shy private joy differs from the issued nod', async () => {
  await sleep(100);
  const a = await connect('stackchan-01', 'device', 'dev-device-01'), b = await connect('stackchan-02', 'device', 'dev-device-02');
  const va = await connect('stackchan-01'), vb = await connect('stackchan-02');
  const isolated = await connect('stackchan-01', 'viewer', '', 'isolated');
  const sa = (await va.wait(x => x.type === 'stream')).data.stream_id, sb = (await vb.wait(x => x.type === 'stream')).data.stream_id;
  let index = 0;
  const pump = async () => { const id = index++; await Promise.all([frame(a, id), frame(b, id, 'stackchan-02')]); };
  const timer = setInterval(() => pump().catch(() => {}), 500);
  const status = setInterval(() => { for (const peer of [a, b]) peer.send('device_status', { online: true, fps: 2, wifi_rssi: null, battery: null, current_action: 'idle' }); }, 5000);
  try {
    await pump();
    const greeting = (await va.wait(x => x.type === 'dialogue' && x.data.speech_act === 'greet' && x.data.from_stream_id === sa)).data;
    assert.equal(greeting.to_stream_id, sb);
    const reply = (await vb.wait(x => x.type === 'dialogue' && x.data.reply_to === greeting.id, 8000)).data;
    assert.equal(reply.from_device_id, 'stackchan-02'); assert.equal(reply.to_device_id, 'stackchan-01'); assert.equal(reply.speech_act, 'acknowledge');
    assert.ok(reply.created_at - greeting.created_at >= 2000);
    const mind = (await vb.wait(x => x.type === 'mind' && x.data.cause.message_id === greeting.id)).data;
    assert.match(mind.thought, /うれしい/); assert.equal(mind.personality, 'shy'); assert.equal(mind.intent, 'engage');
    assert.ok(mind.relationships['stackchan-01'] > .5);
    const outward = (await vb.wait(x => x.type === 'behavior' && x.data?.mind_revision === mind.revision)).data;
    assert.equal(outward.command.expression, 'neutral'); assert.equal(outward.command.action, 'nod'); assert.match(outward.display_text, /控えめ/);
    const actual = (await b.wait(x => x.type === 'action' && x.data.seq === outward.command.seq)).data; assert.deepEqual(actual, outward.command);
    await va.wait(x => x.type === 'mind' && x.data.cause.message_id === reply.id, 8000);
    assert.ok(!JSON.stringify(reply).includes('thought'));
    for (const peer of [a, b]) assert.ok(!peer.messages.some(x => ['mind', 'behavior', 'dialogue', 'dialogue_history'].includes(x.type)), 'FW receives only physical instructions, never thoughts');
    assert.ok(!isolated.messages.some(x => x.type === 'dialogue'), 'Room dialogue must not cross rooms');
    // Acknowledgement is consumed nonverbally; keep pumping across another decision tick.
    await sleep(2200);
    const live = va.messages.filter(x => x.type === 'dialogue' && [sa, sb].includes(x.data.from_stream_id));
    assert.equal(live.length, 2, 'A greeting and acknowledgement must not grow into a reply loop');
    const reconnect = await connect('stackchan-02');
    const history = (await reconnect.wait(x => x.type === 'dialogue_history')).data.messages;
    assert.ok(history.some(x => x.id === reply.id)); reconnect.ws.close(1000);
  } finally { clearInterval(timer); clearInterval(status); for (const peer of [a, b, va, vb, isolated]) peer.ws.close(1000); }
});

test('avert intention holds its gaze despite detections; disconnected conversation is not answered', async () => {
  await sleep(100);
  const a = await connect('stackchan-01', 'device', 'dev-device-01'), b = await connect('stackchan-02', 'device', 'dev-device-02');
  const va = await connect('stackchan-01'), vb = await connect('stackchan-02', 'controller', cookie);
  const sa = (await va.wait(x => x.type === 'stream')).data.stream_id, sb = (await vb.wait(x => x.type === 'stream')).data.stream_id;
  await frame(a, 0); await va.wait(x => x.type === 'dialogue' && x.data.from_stream_id === sa);
  a.ws.close(1000); await va.wait(x => x.type === 'stream' && x.data.stream_id === null);
  await frame(b, 0, 'stackchan-02');
  const avert = (await vb.wait(x => x.type === 'mind' && x.data.intent === 'avert')).data;
  await b.wait(x => x.type === 'action' && x.data.pan === -.35);
  await sleep(900); await frame(b, 1, 'stackchan-02');
  vb.send('detection', detect(sb, 1, .75)); await sleep(100);
  assert.ok(!b.messages.some(x => x.type === 'action' && x.data.seq > 1), 'A face position must not override the chosen avert gaze');
  await sleep(1300); await frame(b, 2, 'stackchan-02'); await sleep(600);
  assert.ok(!vb.messages.some(x => x.type === 'dialogue' && x.data.from_stream_id === sb && x.data.reply_to), 'Do not reply to a disconnected sender');
  assert.ok(!vb.messages.some(x => x.type === 'mind' && x.data.revision > avert.revision && x.data.cause.kind === 'dialogue'));
  const denied = once(vb.ws, 'close'); vb.send('dialogue', { text: 'forged', to_device_id: 'stackchan-01' }); assert.equal((await denied)[0], 1008);
  for (const peer of [b, va]) peer.ws.close(1000);
});


test('local demo restart reconnects both FW clients with new streams', async () => {
  await sleep(100);
  const va = await connect('stackchan-01'), vb = await connect('stackchan-02');
  const clients = new Map(); let gateway;
  for (const [id, token] of [['stackchan-01', 'dev-device-01'], ['stackchan-02', 'dev-device-02']]) {
    clients.set(id, new Simulator({ base, id, token, sharedImage: true, notify: event => gateway?.notify(event) }));
  }
  gateway = startGateway(clients, { port: 8791, origin });
  for (const sim of clients.values()) sim.start();
  let monitor;
  try {
    const a = (await va.wait(x => x.type === 'stream' && x.data.stream_id)).data.stream_id;
    const b = (await vb.wait(x => x.type === 'stream' && x.data.stream_id)).data.stream_id;
    const firstA = await va.wait(x => Buffer.isBuffer(x) && x.readUInt32BE() === 0), firstB = await vb.wait(x => Buffer.isBuffer(x) && x.readUInt32BE() === 0);
    assert.deepEqual(firstA, firstB, 'shared image mode sends identical JPEG bytes to both authenticated devices');
    monitor = new WebSocket('ws://127.0.0.1:8791/monitor', { headers: { Origin: origin } });
    await once(monitor, 'open');
    const restarted = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Demo restart did not finish')), 5000);
      monitor.on('message', raw => { if (JSON.parse(raw).type === 'demo_restarted') { clearTimeout(timeout); resolve(); } });
    });
    monitor.send(JSON.stringify({ type: 'restart_demo' })); await restarted;
    await va.wait(x => x.type === 'stream' && x.data.stream_id && x.data.stream_id !== a);
    await vb.wait(x => x.type === 'stream' && x.data.stream_id && x.data.stream_id !== b);
  } finally { monitor?.close(1000); for (const sim of clients.values()) sim.stop(); gateway.close(); va.ws.close(1000); vb.ws.close(1000); }
});


test('telemetry measures upload, viewer ACK and FW action ACK round trips without image content',async()=>{
 const viewer=await connect('stackchan-01','viewer','','isolated');
 const sim=new Simulator({base,room:'isolated',id:'stackchan-01',token:'dev-isolated-01'});sim.start();
 try {
  const sample=(await viewer.wait(m=>m.type==='telemetry_snapshot' && m.data.transport.upload_rtt.count>0 && m.data.transport.action_ack_rtt.count>0 && m.data.transport.viewer_ack_rtt.count>0,10000)).data;
  assert.ok(viewer.messages.some(m=>m.type==='telemetry' && !('samples' in m.data)), 'ordinary updates do not retransmit detailed histories');
  assert.ok(sample.transport.received_fps>0);assert.ok(sample.transport.frame_to_action_ack.count>0);assert.ok(sample.transport.upload_rtt.p95_ms>=0);
  assert.ok(sample.samples.pipelines.length>0);assert.equal(sample.samples.api.length,0);
  assert.ok(!JSON.stringify(sample).includes('base64'));assert.ok(!JSON.stringify(sample).includes('dev-isolated-01'));
 } finally {sim.stop();viewer.ws.close(1000);}
});
