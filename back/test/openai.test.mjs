import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callDecisions, callNarration, summarizeCalls, OpenAIError } from '../src/openai.ts';
import { narrationPayload, needsNarration, mockNarration } from '../src/narration.ts';
import { socialContext, initialMind } from '../src/social.ts';

const completed = (text, overrides = {}) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(text) }] }], usage: { input_tokens: 100, output_tokens: 35 }, ...overrides });
const response = body => async () => Response.json(body, { headers: { 'x-request-id': 'req-fixture' } });
test('Luna uses fixed Responses endpoint, strict schema, no reasoning and no storage', async () => {
  const payload = narrationPayload({ self: { personality: 'shy' } }, 'reply:other');
  const result = await callNarration('fixture-key', payload, true, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.store, false); assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.max_output_tokens, 256); assert.equal(body.text.format.strict, true); assert.equal(body.text.format.schema.additionalProperties, false);
    return Response.json(completed({ thought: 'うれしいけど照れる。', public_text: 'うん、ありがとう。' }));
  });
  assert.equal(result.text.public_text, 'うん、ありがとう。'); assert.equal(result.metrics.endpoint, 'responses'); assert.equal(result.metrics.output_tokens, 35);
});
test('Decisions transport and combined metrics keep generation output charges visible', async () => {
  const decision = await callDecisions('fixture-key', { model: 'not-allowed' }, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions'); assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
    return Response.json({ answers: [], usage: { input_tokens: 10, output_tokens: 0 } });
  });
  const narration = await callNarration('fixture-key', {}, false, response(completed({ thought: '気になる。', public_text: null })));
  const metrics = summarizeCalls([decision.metrics, narration.metrics], true);
  assert.equal(metrics.input_tokens, 110); assert.equal(metrics.output_tokens, 35); assert.equal(metrics.requests, 2);
  assert.deepEqual(metrics.calls.map(c => c.endpoint), ['decisions', 'responses']);
});
for (const [name, body, speech] of [
  ['refusal', completed({}, { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] }), true],
  ['truncated completion', completed({}, { status: 'incomplete' }), true],
  ['empty thought', completed({ thought: '', public_text: 'hello' }), true],
  ['overlong thought', completed({ thought: 'あ'.repeat(161), public_text: 'hello' }), true],
  ['unexpected command', completed({ thought: 'hello', public_text: 'hello', pan: 999 }), true],
  ['speech on nonverbal intent', completed({ thought: 'hello', public_text: 'hello' }), false],
  ['missing speech on reply', completed({ thought: 'hello', public_text: null }), true]
]) test(`reject ${name} before state or dialogue commit`, async () => {
  await assert.rejects(callNarration('fixture-key', {}, speech, response(body)));
});
test('429 honors bounded cooldown without reflecting key or request data in errors', async () => {
  await assert.rejects(callNarration('fixture-secret', {}, true, async () => new Response('fixture-secret PRIVATE_CONTENT', { status: 429, headers: { 'retry-after': '120' } })), error => {
    assert.ok(error instanceof OpenAIError); assert.equal(error.retryAfterMs, 60000); assert.ok(!error.message.includes('fixture-secret')); return true;
  });
});
test('generation timeout aborts the request', async () => {
  await assert.rejects(callNarration('fixture-key', {}, false, async (_, options) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('Request did not time out')), 500);
    options.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(options.signal.reason); });
  }), 20), /timeout/i);
});
test('narration input has only this robot private state and projected public peers', () => {
  const self = initialMind('self', 'shy'); self.thought = 'SELF_PRIVATE';
  const context = socialContext(self, { happiness: .8 }, {}, [{ device_id: 'other', stream_id: 's', action: 'idle', expression: 'neutral', thought: 'OTHER_PRIVATE', mind: { secret: true } }], undefined, 0);
  const payload = narrationPayload(context, 'avert'), data = JSON.parse(payload.input[1].content);
  assert.equal(data.self.previous_thought, 'SELF_PRIVATE'); assert.ok(!JSON.stringify(payload).includes('OTHER_PRIVATE')); assert.equal(data.selected_choice, 'avert');
});
test('unchanged intentions reuse text until meaningful emotional change or interaction', () => {
  const mind = initialMind('self', 'curious'); mind.generation = { provider: 'openai', model: 'gpt-6-luna', reason: null };
  assert.equal(needsNarration(mind, 'observe', { happiness: .55 }, { happiness: .5 }), false);
  assert.equal(needsNarration(mind, 'observe', { happiness: .8 }, { happiness: .5 }), true);
  assert.equal(needsNarration(mind, 'reply:other', {}, {}), true);
  mind.generation.provider = 'fallback'; assert.equal(needsNarration(mind, 'observe', {}, {}), true);
});
test('offline mock narration changes with observations and marks no model output', () => {
  const a = mockNarration('greet:other', '気になる。', false, { smiling: .9, waving: 0 });
  const b = mockNarration('greet:other', '気になる。', false, { smiling: .1, waving: .9 });
  assert.notEqual(a.public_text, b.public_text); assert.notEqual(a.thought, b.thought);
});

test('RTT covers headers and full body, with metadata only', async () => {
  const records=[];
  await callDecisions('DO_NOT_RECORD_KEY', {secret:'DO_NOT_RECORD_PROMPT'}, async () => {
    await new Promise(r=>setTimeout(r,10));
    return new Response(new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({answers:[],usage:{input_tokens:10,output_tokens:0}})));controller.close();},25);}}),{headers:{'x-request-id':'req-timed'}});
  },4000, sample=>records.push(sample));
  assert.equal(records.length,1);const r=records[0];assert.equal(r.outcome,'success');assert.equal(r.status,200);assert.ok(r.headers_ms>=8);assert.ok(r.rtt_ms>=30);assert.equal(r.request_id,'req-timed');assert.equal(r.input_tokens,10);assert.ok(!JSON.stringify(records).includes('DO_NOT_RECORD'));
});
for (const [kind, fetcher] of [
  ['http_error',async()=>new Response('DO_NOT_RECORD_BODY',{status:429})],
  ['network_error',async()=>{throw new Error('DO_NOT_RECORD_NETWORK_ERROR');}],
  ['invalid_response',async()=>Response.json({not:'answers',usage:{input_tokens:1,output_tokens:0}})]
]) test(`RTT records ${kind} once without raw content`,async()=>{
  const records=[];await assert.rejects(callDecisions('DO_NOT_RECORD_KEY',{},fetcher,4000,s=>records.push(s)));
  assert.equal(records.length,1);assert.equal(records[0].outcome,kind);assert.ok(!JSON.stringify(records).includes('DO_NOT_RECORD'));assert.ok(records[0].rtt_ms>=0);
});
test('timeout and semantic narration failure remain timed attempts',async()=>{
 const records=[];
 await assert.rejects(callNarration('fixture',{},false,async(_,options)=>new Promise((_,reject)=>{const keep=setTimeout(()=>reject(new Error('late')),500);options.signal.addEventListener('abort',()=>{clearTimeout(keep);reject(options.signal.reason);});}),20,s=>records.push(s)));
 assert.equal(records[0].outcome,'timeout');assert.equal(records[0].status,null);assert.ok(records[0].rtt_ms>=15);
 await assert.rejects(callNarration('fixture',{},false,response(completed({thought:'',public_text:null})),3000,s=>records.push(s)));
 assert.equal(records[1].outcome,'invalid_response');assert.equal(records[1].input_tokens,100);
});
