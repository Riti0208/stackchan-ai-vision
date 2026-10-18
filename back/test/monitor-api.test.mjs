import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { monitorJS } from '../src/monitor.ts';

function fixture() {
  let now=100000;
  class Node {
    constructor(){this.children=[];this.style={};this.dataset={};this.handlers={};this.ownText='';this.scrollTop=0;this.scrollHeight=1000;this.clientHeight=300;this.checked=true;}
    set textContent(value){this.ownText=String(value);}
    get textContent(){return this.ownText+this.children.map(n=>n.textContent).join('');}
    append(node){node.remove();this.children.push(node);node.parent=this;}
    insertBefore(node,target){node.remove();const i=this.children.indexOf(target);this.children.splice(i<0?this.children.length:i,0,node);node.parent=this;}
    remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}}
    replaceChildren(){for(const child of [...this.children])child.remove();this.ownText='';}
    setAttribute(){}
    addEventListener(name,handler){this.handlers[name]=handler;}
  }
  const elements=new Map(), intervals=[], sent=[];
  const get=id=>{if(!elements.has(id))elements.set(id,new Node());return elements.get(id);};
  class WS {static OPEN=1;constructor(){this.readyState=1;this.send=value=>sent.push(JSON.parse(value));this.close=()=>{};}}
  const telemetry={transport:{received_fps:0,bytes_received:0,upload_rtt:{},action_ack_rtt:{},frame_to_action_ack:{}},pipeline:{},stages:{perception:{},intention:{},narration:{}}};
  const ui=runInNewContext(monitorJS+`\n({init(){running=true;generation=1;currentRoom='main';attach('robot',1)},message(m){sockets.get('robot').ws.onmessage({data:JSON.stringify(m)})},lost(){sockets.get('robot').ws.onclose({code:1006})},reconnect(){sockets.delete('robot');attach('robot',1)},rows:apiRows,nodes:apiNodes,render:renderAPI,debug:showDebug,inspect:inspectAPI})`,{
    document:{createElement:()=>new Node(),getElementById:get},window:{addEventListener(){}},Date:class extends Date{static now(){return now;}},URL,URLSearchParams,location:{href:'http://localhost/monitor',protocol:'http:'},WebSocket:WS,
    setInterval:fn=>intervals.push(fn),setTimeout(){},clearTimeout(){},clearInterval(){},fetch(){assert.fail('fixture must never call an API');},
  });
  ui.init();get('api-filter').value='all';
  const activity=(state,run='run',sample={})=>ui.message({type:'api_activity',data:{run_id:run,stage:'perception',state,started_at:now,...(state==='completed'?{sample:{started_at:now-1000,rtt_ms:1000,outcome:'success',status:200,...sample}}:{})}});
  return {ui,get,sent,activity,telemetry,advance(ms){now+=ms;for(const fn of intervals)fn();}};
}

test('slow and interrupted calls stay unconfirmed until completion; replayed starts cannot regress completion',()=>{
  const f=fixture();f.activity('started');const row=f.get('api-calls').children[0];
  assert.match(row.textContent,/呼び出し中.*0 秒経過/);f.advance(31000);assert.match(row.textContent,/完了未確認.*31 秒経過/);
  f.ui.lost();assert.match(row.textContent,/接続切断/);assert.equal(f.ui.rows.values().next().value.state,'started');
  // A completed sample from a later snapshot resolves an interrupted row.
  f.activity('completed','run',{started_at:100000});assert.equal(f.get('api-calls').children[0],row);assert.match(row.textContent,/success \/ 200/);
  f.activity('started');assert.match(row.textContent,/success \/ 200/);
});

test('history stays bounded and clear prevents snapshot replay while retaining pending calls',()=>{
  const f=fixture();for(let i=0;i<130;i++)f.activity('completed','run'+i,{started_at:1000+i});
  assert.equal(f.ui.rows.size,100);assert.equal(f.get('api-calls').children.length,100);
  f.activity('started','pending');f.get('api-clear').handlers.click();assert.equal(f.ui.rows.size,1);
  f.ui.message({type:'telemetry_snapshot',data:{...f.telemetry,samples:{api:[{stage:'perception',run_id:'run129',started_at:1129,outcome:'success'}]}}});
  assert.equal(f.ui.rows.size,1);f.activity('completed','pending',{started_at:100000});assert.equal(f.ui.rows.size,1);assert.match(f.get('api-calls').textContent,/success/);
});

test('filters distinguish failures; ordinary updates retain row nodes and reading position',()=>{
  const f=fixture();f.activity('completed','ok');f.activity('completed','bad',{outcome:'http_error',status:429});f.activity('started','waiting');
  const row=f.get('api-calls').children[0];f.get('api-follow').checked=false;f.get('api-scroll').scrollTop=80;f.advance(1000);
  assert.equal(f.get('api-calls').children[0],row);assert.equal(f.get('api-scroll').scrollTop,80);
  f.get('api-scroll').handlers.scroll();assert.equal(f.get('api-follow').checked,false);
  f.get('api-filter').value='failed';f.get('api-filter').handlers.change();assert.equal(f.get('api-calls').children.length,1);assert.match(f.get('api-calls').textContent,/http_error/);
  f.get('api-filter').value='pending';f.get('api-filter').handlers.change();assert.match(f.get('api-calls').textContent,/呼び出し中/);
});

test('JSON details are explicit and survive telemetry replays without unsolicited requests',()=>{
  const f=fixture();f.activity('completed');const item=f.ui.rows.values().next().value;
  f.get('api-calls').children[0].children[6].children[0].handlers.click();assert.equal(f.sent.length,1);assert.equal(f.sent[0].type,'api_debug_request');
  f.ui.debug('robot',{run_id:'run',stage:'perception',detail:{method:'POST',url:'fake',request:{bytes:2,body:{x:1},images_omitted:0},response:null}});
  const body=f.get('api-detail-body').textContent,status=f.get('api-detail-status').textContent;
  f.ui.message({type:'telemetry_snapshot',data:{...f.telemetry,samples:{api:[item]}}});assert.equal(f.get('api-detail-body').textContent,body);assert.equal(f.get('api-detail-status').textContent,status);assert.equal(f.sent.length,1);
  f.ui.lost();assert.match(f.get('api-detail-status').textContent,/接続が切れ/);
});


test('reconnection replays active calls and snapshot-only completions without inventing a result',()=>{
  const f=fixture();f.activity('started');f.ui.lost();f.ui.reconnect();
  assert.match(f.get('api-calls').textContent,/完了未確認/);
  f.activity('started');assert.equal(f.ui.rows.values().next().value.uncertain,false);assert.match(f.get('api-calls').textContent,/呼び出し中/);
  f.ui.message({type:'telemetry_snapshot',data:{...f.telemetry,samples:{api:[{run_id:'run',stage:'perception',started_at:100000,outcome:'network_error',status:null}]}}});
  assert.match(f.get('api-calls').textContent,/network_error/);assert.equal(f.ui.rows.size,1);
  f.ui.inspect(f.ui.rows.values().next().value);
  for(let i=0;i<105;i++)f.activity('started','next'+i);
  assert.equal(f.ui.rows.size,100);assert.equal(f.ui.nodes.size,100);
  f.ui.debug('robot',{run_id:'run',stage:'perception',detail:{method:'POST',url:'fixture',request:null,response:null}});
  assert.match(f.get('api-detail-status').textContent,/fixture/);
});
