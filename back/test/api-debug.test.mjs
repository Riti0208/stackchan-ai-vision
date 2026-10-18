import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callDecisions, callNarration } from '../src/openai.ts';
import { captureDebug, APIDebugCache, debugBytes, DEBUG_BODY_BYTES, DEBUG_TTL_MS, DEBUG_CACHE_BYTES } from '../src/api-debug.ts';
import { guardedFetch } from '../src/paid-session.ts';
import { parseClientMessage } from '../src/protocol.ts';
const secret = 'fake-test-secret-credential';
const ok = { answers: [{ name: 'presence', probability: .9 }], usage: { input_tokens: 10, output_tokens: 2 } };
async function inspect(payload, fetcher, invoke = callDecisions) {
  let detail, timing;
  let value, error;
  try { value = await invoke(secret, payload, fetcher, 1000, sample => timing = sample, sample => detail = sample); }
  catch (caught) { error = caught; }
  return { detail, timing, value, error };
}
test('actual request and successful response are inspected separately from metadata, with images and secrets removed', async () => {
  const payload = { model: 'overridden', input: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,YWJjZA==' }], questions: [{ name: 'presence', type: 'predicate', predicate: 'Is a person visible?' }], context: 'our private context', authorization: secret };
  let sent;
  const result = await inspect(payload, async (_, init) => { sent = JSON.parse(init.body); return Response.json(ok, { headers: { 'x-request-id': 'req-123' } }); });
  assert.equal(sent.model, 'gpt-6-luna');
  assert.equal(result.detail.request.body.model, sent.model);
  assert.deepEqual(JSON.parse(JSON.stringify(result.detail.request.body.questions)), payload.questions);
  assert.equal(result.detail.request.body.context, payload.context);
  assert.deepEqual(result.detail.request.body.input[0].image_url, { omitted: 'image', mime_type: 'image/jpeg', bytes: 4 });
  assert.equal(result.detail.request.images_omitted, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.detail.response.body)), ok); assert.equal(result.detail.error, null);
  assert.equal(result.timing.status, 200); assert.equal(result.timing.request_id, 'req-123');
  assert.doesNotMatch(JSON.stringify(result.detail), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(result.timing), /private context|questions|answers|image_url|authorization/);
});
test('HTTP error JSON preserves code/type/message while credentials are redacted', async () => {
  const result = await inspect({}, async () => Response.json({ error: { code: 'rate_limit', type: 'quota', message: `Denied ${secret} Bearer other-value` }, headers: { Authorization: secret, Cookie: 'private-cookie' } }, { status: 429 }));
  assert.equal(result.timing.outcome, 'http_error'); assert.equal(result.timing.status, 429);
  assert.equal(result.detail.response.body.error.code, 'rate_limit'); assert.equal(result.detail.response.body.error.type, 'quota');
  assert.match(result.detail.response.body.error.message, /Denied/);
  assert.doesNotMatch(JSON.stringify(result.detail), /fake-test-secret|other-value|private-cookie/);
});
test('upstream-before-response exceptions include their real name/message and guard reason', async () => {
  const result = await inspect({}, async () => { throw new TypeError('Illegal invocation: function called with incorrect this reference'); });
  assert.equal(result.detail.error.name, 'TypeError'); assert.match(result.detail.error.message, /Illegal invocation/); assert.equal(result.detail.error.phase, 'fetch');
  assert.equal(result.detail.response, null); assert.equal(result.timing.status, null);
  let upstream = 0;
  const guarded = guardedFetch({}, async () => assert.fail('must not reserve'), async () => { upstream++; });
  const denied = await inspect({}, guarded);
  assert.equal(upstream, 0); assert.equal(denied.detail.error.guard_reason, 'Paid API session is not active'); assert.equal(denied.timing.outcome,'session_stopped');
  const capped=guardedFetch({AI_MODE:'decisions',PAID_SESSION_ID:'test',PAID_SESSION_UNTIL:String(Date.now()+60000),PAID_SESSION_MAX_CALLS:'1'},async()=>({active:false,reason:'call_limit',expires_at:Date.now()+60000}),async()=>{upstream++;});
  const limit=await inspect({},capped);assert.equal(upstream,0);assert.equal(limit.timing.outcome,'session_stopped');assert.equal(limit.timing.status,null);assert.equal(limit.detail.error.guard_reason,'Paid API session stopped: call_limit');
  const stopped = await inspect({}, async () => { throw new DOMException('Session stopped', 'AbortError'); });
  const expired = await inspect({}, async () => { throw new DOMException('Deadline expired', 'TimeoutError'); });
  assert.equal(stopped.detail.error.name, 'AbortError'); assert.equal(expired.detail.error.name, 'TimeoutError');
});
test('narration actual output text and malformed JSON remain inspectable', async () => {
  const output = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ thought: 'hello', public_text: null }) }] }], usage: ok.usage };
  const result = await inspect({ input: 'context' }, async () => Response.json(output), (key, payload, fetcher, timeout, observer, debug) => callNarration(key, payload, false, fetcher, timeout, observer, debug));
  assert.equal(result.detail.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(JSON.parse(JSON.stringify(result.detail.response.body)), output); assert.equal(result.value.text.thought, 'hello');
  const invalid = await inspect({}, async () => new Response('not JSON'));
  assert.equal(invalid.detail.response.body, 'not JSON'); assert.equal(invalid.timing.outcome, 'invalid_response');
});
test('body and error-stream inspection are bounded and explicit about truncation', async () => {
  const value = captureDebug({ text: 'あ'.repeat(100000), more: Array.from({ length: 10000 }, () => 'x') }, 400000, secret);
  assert.ok(debugBytes(value.body) <= DEBUG_BODY_BYTES); assert.equal(value.truncated, true);
  let cancelled = false, pulls = 0;
  const result = await inspect({}, async () => new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(DEBUG_BODY_BYTES + 100)); }, cancel() { cancelled = true; } }), { status: 503 }));
  assert.equal(cancelled, true); assert.ok(pulls < 5); assert.equal(result.detail.response.truncated, true);
  assert.ok(debugBytes(result.detail.response.body) <= DEBUG_BODY_BYTES);
});
test('detail cache enforces count, byte budget and ten-minute expiry without durable storage', () => {
  const cache = new APIDebugCache();
  const detail = { method: 'POST', url: 'https://api.openai.com/v1/decisions', request: captureDebug({}, 2, secret), response: null, error: null };
  for (let i = 0; i < 21; i++) cache.put('call-' + i, detail, 1000);
  assert.equal(cache.get('call-0', 1000), null); assert.ok(cache.get('call-20', 1000));
  assert.equal(cache.get('call-20', 1000 + DEBUG_TTL_MS), null);
  cache.put('too-big', { ...detail, url: 'x'.repeat(DEBUG_CACHE_BYTES + 1) }, 1000);
  assert.equal(cache.get('too-big', 1000), null);
  const large = { ...detail, request: { body: 'x'.repeat(60000), bytes: 60000, truncated: false, images_omitted: 0 } };
  for (let i = 0; i < 20; i++) cache.put('large-' + i, large, 2000);
  assert.equal(cache.get('large-0', 2000), null); assert.ok(cache.get('large-19', 2000));
});
test('debug request wire validation rejects unsafe IDs/stages and device/controller callers', () => {
  const wire = data => JSON.stringify({ type: 'api_debug_request', timestamp: 0, data });
  assert.equal(parseClientMessage(wire({ run_id: 'abc-123', stage: 'perception' }), 'viewer').ok, true);
  for (const data of [{ run_id: '../x', stage: 'perception' }, { run_id: 'a'.repeat(81), stage: 'perception' }, { run_id: 'a', stage: 'unknown' }]) assert.equal(parseClientMessage(wire(data), 'viewer').ok, false);
  for (const role of ['device', 'controller']) assert.equal(parseClientMessage(wire({ run_id: 'a', stage: 'perception' }), role).code, 'forbidden');
});
