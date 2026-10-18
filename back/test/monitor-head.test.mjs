import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import { monitorJS } from '../src/monitor.ts';
function fixture(fetcher) {
  let now = 100000;
  class Node {
    constructor(tag = 'div') { this.tag=tag; this.children=[]; this.style={}; this.attributes={}; this.handlers={}; this.ownText=''; }
    set textContent(value) { this.ownText=String(value); }
    get textContent() { return this.ownText+this.children.map(n=>n.textContent).join(''); }
    append(node) { this.children.push(node); }
    replaceChildren() { this.children=[]; this.ownText=''; }
    setAttribute(name,value) { this.attributes[name]=value; }
    addEventListener(name,listener) { this.handlers[name]=listener; }
  }
  const elements=new Map(), requests=[];
  const context={URLSearchParams,AbortSignal,Date:class extends Date{static now(){return now;}},document:{createElement:tag=>new Node(tag),getElementById:id=>{if(!elements.has(id))elements.set(id,new Node());return elements.get(id);}},window:{addEventListener(){}},setInterval(){},setTimeout(){},clearTimeout(){},fetch:async(url,init)=>{requests.push({url,...init});return fetcher?fetcher(url,init):{ok:true,status:200,json:async()=>({ok:true,device_id:'robot',pan:.2,tilt:0,seq:1,manual_until:110000})};}};
  const ui=runInNewContext(monitorJS+`\n({init(){running=true;generation=1;currentRoom='main';cards.set('robot',{root:document.createElement('article'),data:{device_status:{online:true}},connection:'接続済み'});render('robot');},card(){return cards.get('robot')},command:headCommand,refresh(){updateHead(cards.get('robot'))},disconnect(){running=false;generation++;cards.get('robot').connection='切断';render('robot')},offline(){cards.get('robot').data.device_status.online=false;render('robot')}})`,context);
  ui.init();return {ui,requests,advance(ms){now+=ms;ui.refresh();}};
}
test('head buttons have clear device labels and only send the six head actions, even with OpenAI off', async()=>{
  new Script(monitorJS);
  const f=fixture();
  assert.equal(f.ui.card().headButtons.length,6);
  assert.ok(f.ui.card().headButtons.every(b=>!b.disabled&&b.attributes['aria-label'].startsWith('robot ')));
  for(const action of ['left','right','up','down','center','resume']){
    await f.ui.command('robot',action);f.advance(600);
    const request=f.requests.at(-1);assert.equal(request.url,'/api/control/head?room=main&device_id=robot');assert.equal(request.method,'POST');assert.deepEqual(JSON.parse(request.body),{action});
    assert.deepEqual(JSON.parse(JSON.stringify(request.headers)),{'Content-Type':'application/json'});
  }
  assert.match(f.ui.card().headStatus.textContent,/最後の送信目標: pan 0.20.*送信済み seq 1/);
  assert.doesNotMatch(JSON.stringify(f.requests),/paid-session|Authorization|token/);
});
test('offline/disconnected buttons disable and cannot send; in-flight and cooldown reject duplicate sends',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>resolve=r));
  const first=f.ui.command('robot','left');await f.ui.command('robot','right');assert.equal(f.requests.length,1);assert.ok(f.ui.card().headButtons.every(b=>b.disabled));
  resolve({ok:true,status:200,json:async()=>({ok:true,device_id:'robot',pan:-.2,tilt:0,seq:2,manual_until:110000})});await first;
  await f.ui.command('robot','right');assert.equal(f.requests.length,1);f.advance(600);assert.ok(f.ui.card().headButtons.every(b=>!b.disabled));
  f.ui.offline();assert.ok(f.ui.card().headButtons.every(b=>b.disabled));await f.ui.command('robot','up');assert.equal(f.requests.length,1);
  f.ui.disconnect();assert.ok(f.ui.card().headButtons.every(b=>b.disabled));
});
test('HTTP failures remain visible and expired authentication disables further control',async()=>{
  const failed=fixture(()=>({ok:false,status:503,json:async()=>({error:{code:'device_offline',message:'device offline'}})}));await failed.ui.command('robot','up');assert.match(failed.ui.card().headFeedback,/失敗.*HTTP 503.*device offline/);
  const expired=fixture(()=>({ok:false,status:401,json:async()=>({error:{code:'unauthorized'}})}));await expired.ui.command('robot','up');assert.match(expired.ui.card().headFeedback,/認証期限.*再接続/);expired.advance(1000);assert.ok(expired.ui.card().headButtons.every(b=>b.disabled));await expired.ui.command('robot','left');assert.equal(expired.requests.length,1);
});
test('late responses cannot update a disconnected card; malformed targets are not shown as sent',async()=>{
  let resolve;const stale=fixture(()=>new Promise(r=>resolve=r));const pending=stale.ui.command('robot','left');stale.ui.disconnect();resolve({ok:true,status:200,json:async()=>({ok:true,device_id:'robot',pan:0,tilt:0,seq:1,manual_until:110000})});await pending;assert.equal(stale.ui.card().head,undefined);
  const bad=fixture(()=>({ok:true,status:200,json:async()=>({ok:true,device_id:'robot',pan:99,tilt:0,seq:1,manual_until:110000})}));await bad.ui.command('robot','up');assert.match(bad.ui.card().headFeedback,/応答形式/);assert.equal(bad.ui.card().head,undefined);
});
