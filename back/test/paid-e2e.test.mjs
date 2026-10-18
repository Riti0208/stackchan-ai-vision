import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { syntheticJPEG } from '../scripts/fw-simulator.mjs';
const base = 'http://127.0.0.1:8794';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fixture(vars) {
  await mkdir('.wrangler', { recursive: true }); const directory = await mkdtemp(resolve('.wrangler/budget-e2e-'));
  const cfg = JSON.parse(await readFile('wrangler.local.jsonc', 'utf8')); delete cfg.$schema;
  cfg.main = resolve('test/fixtures/budget-worker.ts'); cfg.assets.directory = resolve('lab');
  const rooms = Object.fromEntries(['main', 'other', 'third'].map(room => [room, { control_token: 'fake', devices: { robot: 'fake-device' } }]));
  Object.assign(cfg.vars, { AI_MODE: 'decisions', OPENAI_API_KEY: 'fake-not-real', SESSION_SECRET: 'fake-signing', ALLOWED_ORIGIN: 'http://127.0.0.1:8787', ROOM_CONFIG: JSON.stringify(rooms), ...vars });
  await writeFile(`${directory}/wrangler.jsonc`, JSON.stringify(cfg));
  await writeFile(`${directory}/.dev.vars`, '');
  let child, log = ''; const sockets = [];
  async function stop() {
    for (const ws of sockets.splice(0)) ws.terminate();
    if (child) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; child = null; }
  }
  async function start() {
    child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', `${directory}/wrangler.jsonc`, '--ip', '127.0.0.1', '--port', '8794', '--inspector-port', '9234', '--persist-to', `${directory}/state`], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs/budget-e2e.log' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await sleep(100); }
    throw new Error(log);
  }
  async function connect(room) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/device?room=${room}&device_id=robot`, { headers: { Authorization: 'Bearer fake-device' } }); sockets.push(ws); await once(ws, 'open');
    const jpeg = await syntheticJPEG(1), packet = Buffer.alloc(jpeg.length + 4); packet.writeUInt32BE(1); jpeg.copy(packet, 4); ws.send(packet); return ws;
  }
  async function loginControl() {
    const response=await fetch(base+'/api/control/session',{method:'POST',headers:{Origin:'http://127.0.0.1:8787','Content-Type':'application/json'},body:JSON.stringify({room:'main',token:'fake'})});
    assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
  }
  async function control(command,cookie,origin='http://127.0.0.1:8787') {
    return fetch(base+'/api/control/paid-session?room=main',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(command)});
  }
  return { start, stop, connect, loginControl, control, monitor: async () => {
    const origin='http://127.0.0.1:8787';
    const response=await fetch(base+'/api/control/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({room:'main',token:'fake'})});
    assert.equal(response.status,200);
    const ws=new WebSocket(base.replace('http','ws')+'/ws/monitor?room=main&device_id=robot',{headers:{Origin:origin,Cookie:response.headers.get('set-cookie').split(';')[0]}});
    ws.observed=[];ws.on('message',raw=>ws.observed.push(JSON.parse(raw.toString())));
    sockets.push(ws);await once(ws,'open');ws.send(JSON.stringify({type:'telemetry_request',timestamp:Date.now(),data:{}}));return ws;
  }, health: async () => (await (await fetch(`${base}/health`)).json()).paid_session, count: async room => (await (await fetch(`${base}/__test/count?room=${room}`)).json()).length, cleanup: async () => { await stop(); await rm(directory, { recursive: true, force: true }); } };
}
test('actual DO budget caps concurrent rooms and survives reconnect and Worker restart', async () => {
  const f = await fixture({ PAID_SESSION_ID: 'paid-e2e', PAID_SESSION_UNTIL: String(Date.now() + 60000), PAID_SESSION_MAX_CALLS: '2' });
  try {
    await f.start(); await Promise.all([f.connect('main'), f.connect('other')]);
    for (let i = 0; i < 60 && (await f.health()).used_calls < 2; i++) await sleep(100);
    assert.equal((await f.health()).reason, 'call_limit');
    assert.equal(await f.count('main') + await f.count('other'), 2);
    await f.connect('third'); await sleep(700); assert.equal(await f.count('third'), 0);
    await f.stop(); await f.start(); await f.connect('main'); await sleep(700);
    assert.equal((await f.health()).used_calls, 2); assert.equal(await f.count('main'), 0);
  } finally { await f.cleanup(); }
});
test('key plus decisions mode without explicit start makes zero upstream requests', async () => {
  const f = await fixture({});
  try { await f.start(); await f.connect('main'); await sleep(700); assert.equal((await f.health()).reason, 'not_started'); assert.equal(await f.count('main'), 0); }
  finally { await f.cleanup(); }
});
test('expired session makes zero upstream requests', async () => {
  const f = await fixture({ PAID_SESSION_ID: 'expired-e2e', PAID_SESSION_UNTIL: String(Date.now() - 1), PAID_SESSION_MAX_CALLS: '30' });
  try { await f.start(); await f.connect('main'); await sleep(700); assert.equal((await f.health()).reason, 'expired'); assert.equal(await f.count('main'), 0); }
  finally { await f.cleanup(); }
});

test('opening monitor and authenticated subscriptions do not call upstream even with an active paid session', async () => {
  const f=await fixture({PAID_SESSION_ID:'monitor-no-side-effects',PAID_SESSION_UNTIL:String(Date.now()+60000),PAID_SESSION_MAX_CALLS:'30'});
  try {
    await f.start(); assert.equal((await fetch(base+'/monitor')).status,200); assert.equal((await fetch(base+'/monitor/app.js')).status,200);
    await f.monitor(); await sleep(1700);
    assert.equal((await f.health()).active,true); assert.equal((await f.health()).used_calls,0); assert.equal(await f.count('main'),0);
  } finally {await f.cleanup();}
});

test('authenticated control toggles live calls, never starts on page load, stops and survives refresh without renewal',async()=>{
  const f=await fixture({AI_MODE:'mock',ENABLE_PAID_CONTROL:'true'});
  try {
    await f.start();await f.connect('main');await sleep(600);
    assert.equal(await f.count('main'),0);assert.equal((await f.health()).reason,'not_started');
    assert.equal((await f.control({action:'start',seconds:300,max_calls:100})).status,401);
    const cookie=await f.loginControl();const observation=await f.monitor();
    assert.equal((await f.control({action:'start',seconds:300,max_calls:100},cookie,'https://evil.example')).status,403);
    assert.equal((await f.control({action:'start',seconds:601,max_calls:100},cookie)).status,400);
    const start=await f.control({action:'start',seconds:300,max_calls:100},cookie);assert.equal(start.status,200);
    const first=await start.json();assert.equal(first.active,true);await f.connect('main');
    assert.equal((await f.control({action:'start',seconds:300,max_calls:100},cookie)).status,409);
    for(let i=0;i<50 && !await f.count('main');i++)await sleep(100);
    assert.ok(await f.count('main')>0);
    for(let i=0;i<30 && !observation.observed.some(m=>m.type==='api_activity'&&m.data.state==='completed');i++)await sleep(50);
    assert.ok(observation.observed.some(m=>m.type==='api_activity'&&m.data.state==='started'));
    assert.ok(observation.observed.some(m=>m.type==='api_activity'&&m.data.state==='completed'&&m.data.sample.status===503));
    assert.doesNotMatch(JSON.stringify(observation.observed),/fake-not-real/);
    await fetch(base+'/monitor');await f.monitor();assert.equal((await f.health()).expires_at,first.expires_at);
    const stop=await f.control({action:'stop'},cookie);assert.equal(stop.status,200);assert.equal((await stop.json()).reason,'stopped');
    const count=await f.count('main');await f.connect('other');await sleep(900);assert.equal(await f.count('main'),count);assert.equal(await f.count('other'),0);
    await f.stop();await f.start();assert.equal((await f.health()).reason,'stopped');
    const restart=await f.control({action:'start',seconds:1,max_calls:1},await f.loginControl());assert.equal(restart.status,200);
    await sleep(1100);assert.equal((await f.health()).active,false);
  } finally {await f.cleanup();}
});
