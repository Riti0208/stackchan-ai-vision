import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { monitorHTML, monitorJS } from '../src/monitor.ts';

test('monitor room pattern is valid under browser Unicode Sets validation', () => {
  const pattern = monitorHTML.match(/id="room"[^>]*pattern="([^"]+)"/)[1];
  const room = new RegExp(`^(?:${pattern})$`, 'v');
  for (const value of ['main', 'room-2', 'a_b', '0', 'a'.repeat(32)]) assert.ok(room.test(value), value);
  for (const value of ['', '-main', '_main', 'Main', 'a/b', 'a b', 'a'.repeat(33)]) assert.ok(!room.test(value), value);
});

test('monitor script initializes without network or paid-session side effects', () => {
  const handlers = new Map();
  const elements = new Map();
  const unexpected = () => assert.fail('page initialization must not make network requests');
  runInNewContext(monitorJS, {
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { addEventListener(type, listener) { handlers.set(`${id}:${type}`, listener); } });
      return elements.get(id);
    } },
    window: { addEventListener() {} }, setInterval() {}, fetch: unexpected, WebSocket: unexpected,
  });
  for (const event of ['login:submit', 'disconnect:click', 'paid-start:click', 'paid-stop:click']) assert.equal(typeof handlers.get(event), 'function');
});
