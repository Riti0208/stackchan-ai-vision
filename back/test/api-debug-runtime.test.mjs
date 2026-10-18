import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debugFixture, privateMarker, fakeKey } from './fixtures/api-debug-runtime.mjs';

test('actual Room serves bounded bodies only on authenticated monitor request and never in telemetry/logs', { timeout: 15000 }, async () => {
  const logs = [], original = console.log; console.log = (...args) => logs.push(args);
  let f;
  try {
    f = await debugFixture();
    assert.equal((await f.fetch('/ws/monitor?room=main&device_id=robot', { headers: { Upgrade: 'websocket', Origin: 'https://debug-test.invalid' } })).status, 401);
    const cookie = await f.login();
    const monitor = await f.connect('/ws/monitor?room=main&device_id=robot', { Cookie: cookie });
    const viewer = await f.connect('/ws/viewer?room=main&device_id=robot');
    assert.equal(f.requests.length, 0);
    await f.device();
    const completed = await monitor.wait(m => m.type === 'api_activity' && m.data.state === 'completed');
    assert.equal(completed.data.sample.status, 400);
    assert.doesNotMatch(JSON.stringify(monitor.messages), new RegExp(privateMarker));
    const request = { type: 'api_debug_request', timestamp: Date.now(), data: { run_id: completed.data.run_id, stage: 'perception' } };
    viewer.ws.send(JSON.stringify(request));
    const forbidden = await viewer.wait(m => m.type === 'error' && m.data.code === 'forbidden'); assert.ok(forbidden);
    assert.doesNotMatch(JSON.stringify(viewer.messages), new RegExp(privateMarker));
    monitor.ws.send(JSON.stringify(request));
    const result = await monitor.wait(m => m.type === 'api_debug');
    assert.equal(result.data.detail.request.body.model, 'gpt-6-luna');
    assert.ok(result.data.detail.request.images_omitted > 0);
    assert.equal(result.data.detail.response.body.error.code, 'fixture_error');
    assert.match(result.data.detail.response.body.error.message, new RegExp(privateMarker));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(fakeKey + '|fixture-cookie|data:image/jpeg;base64'));
    const other = await f.connect('/ws/monitor?room=main&device_id=other', { Cookie: cookie });
    other.ws.send(JSON.stringify(request)); assert.equal((await other.wait(m => m.type === 'api_debug')).data.detail, null);
    const reconnect = await f.connect('/ws/monitor?room=main&device_id=robot', { Cookie: cookie });
    reconnect.ws.send(JSON.stringify(request)); assert.ok((await reconnect.wait(m => m.type === 'api_debug')).data.detail);
    monitor.ws.send(JSON.stringify({ type: 'telemetry_request', timestamp: Date.now(), data: {} }));
    const snapshot = await monitor.wait(m => m.type === 'telemetry_snapshot');
    assert.doesNotMatch(JSON.stringify(snapshot), /fixture-private-upstream-body|image_url|predicate|fake-debug-fixture-key/);
    assert.equal(f.requests.length, 1, 'inspection and reconnects must not start another API request');
    assert.doesNotMatch(JSON.stringify(logs), /fixture-private-upstream-body|image_url|fake-debug-fixture-key|fixture-cookie/);
  } finally { await f?.dispose(); console.log = original; }
});
