import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidSession, reservePaidCall, guardedFetch } from '../src/paid-session.ts';
import { demoLimits, prepareMockConfig, readLocalVars } from '../scripts/local-env.mjs';
function configuration(extra = {}) { return { AI_MODE: 'decisions', PAID_SESSION_ID: 'session-1', PAID_SESSION_UNTIL: String(Date.now() + 60000), PAID_SESSION_MAX_CALLS: '3', ...extra }; }
// Models the serialized storage transaction, including shared calls from multiple rooms.
function storage() {
  const values = new Map(); let tail = Promise.resolve();
  const tx = { async get(k) { return values.get(k); }, async put(k, v) { values.set(k, v); } };
  return { transaction(fn) { const result = tail.then(() => fn(tx)); tail = result.catch(() => {}); return result; } };
}
test('no session, invalid limits, mock and expiry all fail closed', () => {
  for (const extra of [{ PAID_SESSION_ID: '' }, { PAID_SESSION_UNTIL: '' }, { PAID_SESSION_UNTIL: '0' }, { PAID_SESSION_MAX_CALLS: '0' }, { PAID_SESSION_MAX_CALLS: '1.5' }, { PAID_SESSION_MAX_CALLS: '1001' }, { AI_MODE: 'mock' }]) assert.equal(paidSession(configuration(extra)).active, false);
  assert.equal(paidSession(configuration(), 0, Number(configuration().PAID_SESSION_UNTIL) + 1).reason, 'expired');
});
test('concurrent rooms/devices share a durable cap; restart and reconnect cannot replenish it', async () => {
  const state = storage(), env = configuration();
  const results = await Promise.all(Array.from({ length: 20 }, () => reservePaidCall(state, env, true)));
  assert.equal(results.filter(s => s.active).length, 3);
  assert.deepEqual(await reservePaidCall(state, env, false), { active: false, reason: 'call_limit', expires_at: Number(env.PAID_SESSION_UNTIL), max_calls: 3, used_calls: 3 });
  assert.equal((await reservePaidCall(state, { ...env }, true)).active, false);
  assert.equal((await reservePaidCall(state, { ...env, PAID_SESSION_ID: 'explicit-new-session' }, true)).active, true);
});
test('both endpoints and failures consume slots, blocked calls never reach upstream', async () => {
  const state = storage(), env = configuration(); let calls = 0;
  const guarded = guardedFetch(env, () => reservePaidCall(state, env, true), async () => { calls++; throw new Error('fake upstream failure'); });
  for (const endpoint of ['decisions', 'responses', 'decisions']) await assert.rejects(guarded(`https://api.openai.com/v1/${endpoint}`), /fake upstream failure/);
  await assert.rejects(guarded('https://api.openai.com/v1/responses'), /call_limit/);
  assert.equal(calls, 3);
});
test('missing start and reservation failure make zero upstream requests', async () => {
  let calls = 0;
  const outbound = async () => { calls++; return new Response(); };
  await assert.rejects(guardedFetch({}, async () => { throw new Error('must not reserve'); }, outbound)('https://example.test'), /not active/);
  await assert.rejects(guardedFetch(configuration(), async () => { throw new Error('storage unavailable'); }, outbound)('https://example.test'), /storage unavailable/);
  assert.equal(calls, 0);
});
test('session deadline aborts an in-flight request', async () => {
  const env = configuration({ PAID_SESSION_UNTIL: String(Date.now() + 50) });
  const guarded = guardedFetch(env, async () => paidSession(env), async (_, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response()), 1000);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
  }));
  await assert.rejects(guarded('https://example.test'), error => error.name === 'TimeoutError');
});
test('CLI has finite defaults and refuses typos, unbounded and duplicated options', () => {
  assert.deepEqual(demoLimits(), { seconds: 60, maxCalls: 30 });
  assert.deepEqual(demoLimits(['--openai', '--seconds', '120', '--max-calls', '50', '--same-image']), { seconds: 120, maxCalls: 50 });
  for (const args of [['--seconds'], ['--seconds', '0'], ['--seconds', 'Infinity'], ['--seconds', '601'], ['--max-calls', '1001'], ['--max-calls', '1.5'], ['--max-calls', '3', '--max-calls', '4'], ['--opneai']]) assert.throws(() => demoLimits(args));
});
test('default local configuration forces mock and strips keys/start grants even if local settings request real mode', async () => {
  const prepared = await prepareMockConfig({ AI_MODE: 'decisions', OPENAI_API_KEY: 'must-not-copy', OPENAI_API_KEY_REF: 'op://must/not/read', PAID_SESSION_ID: 'old-start', ROOM_CONFIG: '{}', SESSION_SECRET: 'fixture-session', ALLOWED_ORIGIN: 'http://127.0.0.1:8787' });
  try {
    const vars = await readLocalVars(prepared.path.replace('wrangler.jsonc', '.dev.vars'));
    assert.equal(vars.AI_MODE, 'mock'); assert.equal(vars.OPENAI_API_KEY, undefined); assert.equal(vars.OPENAI_API_KEY_REF, undefined); assert.equal(vars.PAID_SESSION_ID, undefined); assert.equal(prepared.expiresAt, null);
  } finally { await prepared.cleanup(); }
});

test('demo auto-stop closes on deadline, cap and unreadable budget without restarting', async () => {
  const { watchPaidSession } = await import('../scripts/paid-session.mjs');
  for (const mode of ['deadline', 'cap', 'error']) {
    let stops = 0; const reports = [];
    const cancel = watchPaidSession({ expiresAt: Date.now() + (mode === 'deadline' ? 25 : 1000), intervalMs: 5,
      readStatus: async () => { if (mode === 'error') throw new Error('offline'); return mode === 'cap' ? { active: false, reason: 'call_limit' } : { active: true }; },
      stop: () => stops++, report: reason => reports.push(reason) });
    await new Promise(r => setTimeout(r, 60)); cancel();
    assert.equal(stops, 1); assert.deepEqual(reports, [mode === 'deadline' ? 'expired' : mode === 'cap' ? 'call_limit' : 'unavailable']);
  }
});

test('manual sessions start only explicitly, preserve shared caps, stop and reject previous grants', async () => {
  const {controlledBudget,updatePaidSession}=await import('../src/paid-session.ts');
  const state=storage(), env={ENABLE_PAID_CONTROL:'true',OPENAI_API_KEY:'fake',VERSION_METADATA:{id:'v1'}};
  assert.equal((await controlledBudget(state,env)).reason,'not_started');
  const results=await Promise.allSettled(Array.from({length:10},()=>updatePaidSession(state,env,{action:'start',seconds:300,max_calls:2})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const initial=await controlledBudget(state,env);
  const calls=await Promise.all(Array.from({length:10},()=>controlledBudget(state,env,true,initial.session_id)));
  assert.equal(calls.filter(r=>r.active).length,2);
  assert.equal((await controlledBudget(state,env)).reason,'call_limit');
  const stopped=await updatePaidSession(state,env,{action:'stop'});assert.equal(stopped.reason,'stopped');assert.equal(stopped.used_calls,2);
  const next=await updatePaidSession(state,env,{action:'start',seconds:300,max_calls:100});
  assert.notEqual(next.session_id,initial.session_id);
  assert.equal((await controlledBudget(state,env,true,initial.session_id)).reason,'session_changed');
  assert.equal((await controlledBudget(state,{...env,VERSION_METADATA:{id:'v2'}})).reason,'deployment_changed');
});
test('manual session bounds, capability and API key are enforced before any grant', async()=>{
  const {updatePaidSession,controlledBudget}=await import('../src/paid-session.ts');
  const state=storage(), env={ENABLE_PAID_CONTROL:'true',OPENAI_API_KEY:'fake'};
  await assert.rejects(updatePaidSession(state,{}, {action:'start',seconds:300,max_calls:100}),/control_disabled/);
  await assert.rejects(updatePaidSession(state,{ENABLE_PAID_CONTROL:'true'}, {action:'start',seconds:300,max_calls:100}),/key_not_configured/);
  for(const [seconds,max_calls] of [[0,100],[601,100],[300,0],[300,1001],[1.5,2]]) await assert.rejects(updatePaidSession(state,env,{action:'start',seconds,max_calls}),/invalid_limits/);
  assert.equal((await controlledBudget(state,env)).active,false);
});
