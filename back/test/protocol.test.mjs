import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientRoles, parseClientMessage, parseDeviceServerMessage, serializeClient, serializeServer } from '../src/protocol.ts';
const samples = {
  device_status: { online: true, fps: 2, wifi_rssi: null, battery: null, current_action: 'idle', transport: { upload_rtt_ms: 3 } },
  action_ack: { seq: 1, accepted: true }, frame_ack: { stream_id: 's', frame_id: 0xffffffff },
  detection: { stream_id: 's', frame_id: 1, faces: [], primary_face_id: null }, heartbeat: {}, telemetry_request: {}
};
const wire = (type, data) => JSON.stringify({ type, timestamp: 0, data });
test('every client message is validated against both discriminator and allowed role', () => {
  for (const [type, data] of Object.entries(samples)) {
    const raw = serializeClient({ type, timestamp: 0, data });
    for (const role of ['device', 'viewer', 'controller']) {
      const result = parseClientMessage(raw, role);
      if (clientRoles[type].includes(role)) { assert.equal(result.ok, true); assert.deepEqual(result.message.data, data); }
      else assert.deepEqual(result, { ok: false, code: 'forbidden', fatal: true });
    }
  }
});
test('malformed envelopes, mismatched payloads and server spoofing are rejected', () => {
  for (const raw of ['{', 'null', '[]', wire('frame_ack', []), wire('frame_ack', { frame_id: 1 }), JSON.stringify({ type: 'frame_ack', timestamp: .5, data: samples.frame_ack })]) assert.equal(parseClientMessage(raw, 'controller').ok, false);
  assert.equal(parseClientMessage(wire('__proto__', {}), 'controller').code, 'unknown_type');
  assert.equal(parseClientMessage(wire('heartbeat', { extension_field: true }), 'controller').ok, true);
  for (const type of ['action', 'mind', 'emotion', 'decision', 'telemetry_snapshot']) assert.deepEqual(parseClientMessage(wire(type, {}), 'controller'), { ok: false, code: 'forbidden', fatal: true });
  assert.equal(parseClientMessage(wire('action_ack', samples.frame_ack), 'device').ok, false);
});
test('status and ACK value ranges retain wire rejection codes', () => {
  for (const patch of [{ fps: -1 }, { fps: 1001 }, { battery: 101 }, { wifi_rssi: -201 }, { current_action: 'run' }, { transport: [] }, { transport: { upload_rtt_ms: 60001 } }]) assert.equal(parseClientMessage(wire('device_status', { ...samples.device_status, ...patch }), 'device').code, 'invalid_status');
  for (const frame_id of [-1, .5, 0x100000000]) assert.equal(parseClientMessage(wire('frame_ack', { stream_id: 's', frame_id }), 'viewer').ok, false);
});
test('detection validates face IDs, geometry, max count and deterministic primary selection', () => {
  const a = { id: 2, x: .2, y: .1, width: .2, height: .3, confidence: .9 }, b = { ...a, id: 1 };
  const check = (faces, primary_face_id) => parseClientMessage(wire('detection', { stream_id: 's', frame_id: 1, faces, primary_face_id }), 'controller').ok;
  assert.equal(check([a, b], 1), true); assert.equal(check([a, b], 2), false);
  assert.equal(check([a, a], 2), false); assert.equal(check([{ ...a, width: 0 }], 2), false);
  assert.equal(check([{ ...a, x: .9 }], 2), false); assert.equal(check([{ ...a, confidence: 1.1 }], 2), false);
  assert.equal(check(Array.from({ length: 11 }, (_, id) => ({ ...a, id })), 0), false);
});
test('FW accepts bounded commands/session/frame ACK/error and ignores malformed or private messages', () => {
  const command = { seq: 1, action: 'nod', pan: -1, tilt: 1, expression: 'neutral', duration_ms: 100 };
  assert.equal(parseDeviceServerMessage(serializeServer('action', command)).type, 'action');
  for (const expression of ['sleepy', 'love', 'wink']) assert.equal(parseDeviceServerMessage(wire('action', { ...command, expression })).type, 'action');
  for (const patch of [{ seq: 0 }, { seq: -1 }, { pan: 1.01 }, { tilt: -1.01 }, { duration_ms: 99 }, { duration_ms: 3001 }, { duration_ms: 100.5 }, { expression: 'angry' }, { action: 'run' }]) assert.equal(parseDeviceServerMessage(wire('action', { ...command, ...patch })), null);
  assert.equal(parseDeviceServerMessage(wire('frame_received', { stream_id: 's', frame_id: 0 } )).type, 'frame_received');
  assert.equal(parseDeviceServerMessage(wire('session', { protocol_version: 2, frame_format: 'rgb565le-v2', width: 160, height: 120, room: 'main', device_id: 'robot', role: 'device' })).type, 'session');
  assert.equal(parseDeviceServerMessage(wire('error', { code: 'invalid_message', message: 'invalid_message' })).type, 'error');
  for (const raw of ['{', wire('mind', { thought: 'private' }), wire('session', { protocol_version: 1, room: 'main', device_id: 'robot', role: 'controller' })]) assert.equal(parseDeviceServerMessage(raw), null);
});

test('communication document client and motor examples match shared runtime validators', async () => {
  const { readFile } = await import('node:fs/promises');
  const doc = await readFile(new URL('../../doc/communication_protocol_v1.md', import.meta.url), 'utf8');
  let checked = 0;
  for (const match of doc.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const sample = JSON.parse(match[1]);
    if (Object.hasOwn(clientRoles, sample.type)) {
      const result = parseClientMessage(JSON.stringify(sample), clientRoles[sample.type][0]);
      assert.equal(result.ok, true, `Document example ${sample.type} must satisfy the contract`); checked++;
    } else if (sample.type === 'action' || sample.type === 'frame_received') {
      assert.notEqual(parseDeviceServerMessage(JSON.stringify(sample)), null); checked++;
    }
  }
  assert.ok(checked >= 6);
});

test('device sessions require v2 format and dimensions; legacy or incomplete sessions fail closed',()=>{
 const session={protocol_version:2,frame_format:'rgb565le-v2',width:160,height:120,room:'main',device_id:'robot',role:'device'};
 for(const changed of [{protocol_version:1},{frame_format:'jpeg'},{width:320},{height:240},{frame_format:undefined}])assert.equal(parseDeviceServerMessage(wire('session',{...session,...changed})),null);
});
