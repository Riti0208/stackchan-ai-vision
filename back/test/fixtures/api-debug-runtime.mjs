import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
export const fakeKey = 'fake-debug-fixture-key';
export const privateMarker = 'fixture-private-upstream-body';
export function rawFixtureFrame() {
  const packet = new Uint8Array(16 + 160 * 120 * 2), view = new DataView(packet.buffer);
  packet.set([83, 67, 70, 87, 2, 1]); view.setUint16(6, 160); view.setUint16(8, 120); view.setUint32(10, 1);
  return packet;
}
export function observe(ws) {
  const messages = [];
  ws.addEventListener('message', event => { if (typeof event.data === 'string') messages.push(JSON.parse(event.data)); }); ws.accept();
  return { messages, async wait(predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const found = messages.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail('Expected fixture message within 5 seconds');
  } };
}
export async function debugFixture({ origin = 'https://debug-test.invalid', port = 0 } = {}) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bundled = await build({ absWorkingDir: root, entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const requests = [], sockets = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    port, modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-10-17', log: new Log(LogLevel.NONE),
    durableObjects: { ROOMS: { className: 'Room', useSQLite: true } },
    bindings: { AI_MODE: 'decisions', OPENAI_API_KEY: fakeKey, SESSION_SECRET: 'fixture-signing', ALLOWED_ORIGIN: origin,
      ROOM_CONFIG: JSON.stringify({ main: { control_token: 'fake-control', devices: { robot: 'fake-device', other: 'fake-device' } } }),
      PAID_SESSION_ID: 'debug-test', PAID_SESSION_UNTIL: String(Date.now() + 60000), PAID_SESSION_MAX_CALLS: '2' },
    // No real outbound network, including on assertion failures.
    outboundService: async request => {
      requests.push({ url: request.url, method: request.method });
      assert.equal(request.url, 'https://api.openai.com/v1/decisions');
      return Response.json({ error: { code: 'fixture_error', type: 'fixture_type', message: `${privateMarker}: invalid input ${fakeKey}` }, Authorization: fakeKey, Cookie: 'fixture-cookie' }, { status: 400, headers: { 'x-request-id': 'req-debug-fixture' } });
    },
  }));
  const fetch = (path, init) => mf.dispatchFetch(origin + path, init);
  async function connect(path, headers = {}) {
    const response = await fetch(path, { headers: { Upgrade: 'websocket', Origin: origin, ...headers } });
    assert.equal(response.status, 101); sockets.push(response.webSocket); return { ws: response.webSocket, ...observe(response.webSocket) };
  }
  return { mf, requests, fetch, connect, async login() {
    const response = await fetch('/api/control/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'main', token: 'fake-control' }) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  }, async device() {
    const client = await connect('/ws/device?room=main&device_id=robot', { Authorization: 'Bearer fake-device' });
    await client.wait(m => m.type === 'session'); client.ws.send(rawFixtureFrame()); return client;
  }, async dispose() { for (const socket of sockets) socket.close(1000); await mf.dispose(); } };
}
