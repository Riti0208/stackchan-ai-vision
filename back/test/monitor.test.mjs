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

test('paid duration defaults to unlimited and null expiry is displayed without remaining seconds', async () => {
  assert.match(monitorHTML, /id="paid-seconds" type="number" min="0" max="600" value="0"/);
  assert.match(monitorHTML, /0=時間無制限/);
  const elements=new Map(), requests=[];
  const get=id=>{if(!elements.has(id))elements.set(id,{addEventListener(){}});return elements.get(id);};
  let health={ai_mode:'decisions',paid_control:{enabled:true,key_configured:true,room:'main'},paid_session:{active:true,expires_at:null,used_calls:2,max_calls:100}};
  const ui=runInNewContext(monitorJS+`\n({show(h){running=true;currentRoom='main';lastHealth=h;showPaid()},command:paidCommand})`,{
    document:{getElementById:get},window:{addEventListener(){}},setInterval(){},Date,AbortSignal,URLSearchParams,
    fetch:async(url,init)=>{requests.push({url,...init});return {ok:true,json:async()=>url.startsWith('/health')?health:{ok:true}};},
  });
  ui.show(health);
  assert.equal(requests.length,0);
  assert.match(get('paid-result').textContent,/時間無制限 \/ 2 \/ 100 回/);
  assert.doesNotMatch(get('paid-result').textContent,/残り|NaN/);
  assert.equal(get('paid-start').disabled,true);assert.equal(get('paid-stop').disabled,false);
  health={...health,paid_session:{...health.paid_session,expires_at:Date.now()+30000}};ui.show(health);
  assert.match(get('paid-result').textContent,/残り 30 秒/);
  get('paid-calls').value='100';get('paid-seconds').value='0';
  await ui.command('start');
  assert.deepEqual(JSON.parse(requests[0].body),{action:'start',seconds:0,max_calls:100});
  assert.equal(requests[0].url,'/api/control/paid-session?room=main');
  requests.length=0;
  for(const seconds of ['-1','601','1.5']){get('paid-seconds').value=seconds;await ui.command('start');}
  get('paid-seconds').value='0';for(const calls of ['-1','9007199254740992','1.5','']){get('paid-calls').value=calls;await ui.command('start');}
  assert.equal(requests.length,0);assert.match(get('paid-result').textContent,/0〜600秒/);
  get('paid-seconds').value='600';get('paid-calls').value='1000';await ui.command('start');
  assert.deepEqual(JSON.parse(requests[0].body),{action:'start',seconds:600,max_calls:1000});
  requests.length=0;await ui.command('stop');assert.deepEqual(JSON.parse(requests[0].body),{action:'stop'});
});


test('updating deployment disables start without sending and keeps stop available',async()=>{
 const elements=new Map(),requests=[];
 const get=id=>{if(!elements.has(id))elements.set(id,{addEventListener(){}});return elements.get(id);};
 let health={deployment:{ready:false},paid_control:{enabled:true,key_configured:true,room:'main'},paid_session:{active:true,expires_at:null,used_calls:2,max_calls:100}};
 const ui=runInNewContext(monitorJS+`\n({show(h){running=true;currentRoom='main';lastHealth=h;showPaid()},command:paidCommand})`,{document:{getElementById:get},window:{addEventListener(){}},setInterval(){},Date,AbortSignal,URLSearchParams,fetch:async(url,init)=>{requests.push({url,...init});return {ok:true,json:async()=>url.startsWith('/health')?health:{ok:true}};}});
 ui.show(health);assert.equal(get('paid-start').disabled,true);assert.equal(get('paid-stop').disabled,false);assert.match(get('paid-result').textContent,/更新を反映中/);
 get('paid-seconds').value='0';get('paid-calls').value='100';await ui.command('start');assert.equal(requests.length,0);
 await ui.command('stop');assert.deepEqual(JSON.parse(requests[0].body),{action:'stop'});assert.equal(get('paid-start').disabled,true);
 health={...health,deployment:{ready:true},paid_session:{...health.paid_session,active:false}};ui.show(health);assert.equal(get('paid-start').disabled,false);assert.equal(requests.filter(x=>x.method==='POST').length,1);
});

test('monitor accepts explicit unlimited or larger call budgets and labels unlimited status',async()=>{
 const elements=new Map(),requests=[];
 const get=id=>{if(!elements.has(id))elements.set(id,{addEventListener(){}});return elements.get(id);};
 const health={ai_mode:'mock',paid_control:{enabled:true,key_configured:true,room:'main'},paid_session:{active:true,expires_at:null,max_calls:0,used_calls:1005},deployment:{ready:true}};
 const ui=runInNewContext(monitorJS+`\n({show(h){running=true;currentRoom='main';lastHealth=h;showPaid()},command:paidCommand})`,{document:{getElementById:get},window:{addEventListener(){}},setInterval(){},Date,AbortSignal,URLSearchParams,fetch:async(url,init)=>{requests.push({url,...init});return {ok:true,json:async()=>url.startsWith('/health')?health:{ok:true}};}});
 ui.show(health);assert.match(get('paid-result').textContent,/1005 \/ 無制限/);assert.equal(requests.length,0);
 for(const max of [0,5000]){get('paid-seconds').value='0';get('paid-calls').value=String(max);requests.length=0;await ui.command('start');assert.deepEqual(JSON.parse(requests[0].body),{action:'start',seconds:0,max_calls:max});}
});
