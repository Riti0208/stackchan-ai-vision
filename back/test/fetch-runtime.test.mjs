import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://runtime-test.invalid';

// Both deployed v1 and raw-camera v2 exercise the same production Room path.
function frame(version) {
  if (version === 1) return Uint8Array.of(0, 0, 0, 1, 255, 216, 255, 217);
  assert.equal(version, 2);
  const packet = new Uint8Array(16 + 160 * 120 * 2), view = new DataView(packet.buffer);
  packet.set([83, 67, 70, 87, 2, 1]);
  view.setUint16(6, 160); view.setUint16(8, 120); view.setUint32(10, 1);
  return packet;
}
function observed(ws) {
  const messages = [];
  ws.addEventListener('message', event => { if (typeof event.data === 'string') messages.push(JSON.parse(event.data)); });
  ws.accept();
  return async predicate => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = messages.find(predicate);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('No expected session/API activity within 5 seconds');
  };
}
async function exercise(legacyReceiver) {
  const bundled = await build({
    absWorkingDir: root, entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: legacyReceiver ? [{ name: 'reproduce-original-fetch-receiver', setup(builder) {
      builder.onLoad({ filter: /[/\\]src[/\\]index\.ts$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        // Reproduce the pre-fix default without modifying any checkout files.
        const contents = source.replace('private aiFetch: typeof fetch = (input, init) => fetch(input, init)', 'private aiFetch: typeof fetch = fetch');
        assert.match(contents, /private aiFetch: typeof fetch = fetch/);
        return { contents, loader: 'ts' };
      });
    } }] : [],
  });
  const requests = [], sockets = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-10-17',
    log: new Log(LogLevel.NONE), durableObjects: { ROOMS: { className: 'Room', useSQLite: true } },
    bindings: {
      AI_MODE: 'decisions', OPENAI_API_KEY: 'fake-runtime-test-key', SESSION_SECRET: 'fake-runtime-test-signing', ALLOWED_ORIGIN: origin,
      ROOM_CONFIG: JSON.stringify({ main: { control_token: 'fake-control', devices: { robot: 'fake-device' } } }),
      PAID_SESSION_ID: 'runtime-test', PAID_SESSION_UNTIL: String(Date.now() + 60000), PAID_SESSION_MAX_CALLS: '2',
    },
    // Every outbound subrequest is intercepted; this runtime has no external fallback.
    outboundService: async request => {
      requests.push({ url: request.url, method: request.method });
      assert.equal(request.url, 'https://api.openai.com/v1/decisions');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('authorization'), 'Bearer fake-runtime-test-key');
      return new Response(null, { status: 503, headers: { 'x-request-id': 'req-local-runtime-test' } });
    },
  }));
  try {
    const login = await mf.dispatchFetch(origin + '/api/control/session', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'main', token: 'fake-control' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const monitor = await mf.dispatchFetch(origin + '/ws/monitor?room=main&device_id=robot', { headers: { Upgrade: 'websocket', Origin: origin, Cookie: cookie } });
    assert.equal(monitor.status, 101); sockets.push(monitor.webSocket);
    const activity = observed(monitor.webSocket);
    assert.equal(requests.length, 0, 'opening a monitor must remain passive');
    const device = await mf.dispatchFetch(origin + '/ws/device?room=main&device_id=robot', { headers: { Upgrade: 'websocket', Authorization: 'Bearer fake-device' } });
    assert.equal(device.status, 101); sockets.push(device.webSocket);
    const received = observed(device.webSocket);
    const session = await received(message => message.type === 'session');
    device.webSocket.send(frame(session.data.protocol_version));
    const completed = await activity(message => message.type === 'api_activity' && message.data.state === 'completed');
    const unavailable = await activity(message => message.type === 'error' && message.data.code === 'ai_unavailable');
    const health = await (await mf.dispatchFetch(origin + '/health')).json();
    return { sample: completed.data.sample, endpoint: completed.data.endpoint, unavailable: unavailable.data, requests, used: health.paid_session.used_calls };
  } finally {
    for (const socket of sockets) socket.close(1000);
    await mf.dispose();
  }
}

test('real Workers runtime reproduces the original fetch receiver failure before outbound', { timeout: 15000 }, async () => {
  const result = await exercise(true);
  assert.equal(result.sample.outcome, 'network_error');
  assert.equal(result.sample.status, null); assert.equal(result.sample.request_id, null);
  assert.equal(result.requests.length, 0); assert.equal(result.used, 1);
  assert.equal(result.unavailable.retry_after_ms, 10000);
});

test('production Room default fetch reaches intercepted upstream in Workers runtime', { timeout: 15000 }, async () => {
  const result = await exercise(false);
  assert.equal(result.sample.outcome, 'http_error');
  assert.equal(result.sample.status, 503); assert.equal(result.sample.request_id, 'req-local-runtime-test');
  assert.equal(result.endpoint, 'decisions'); assert.equal(result.requests.length, 1); assert.equal(result.used, 1);
  assert.match(result.unavailable.message, /503/);
});
