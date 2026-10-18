import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
const origin='https://follow-test.invalid';
const bundle=await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'browser'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,ms=7000){const end=Date.now()+ms;while(Date.now()<end){const v=predicate();if(v)return v;await sleep(10);}assert.fail('Local follow/manual condition timed out');}
function raw(id){const b=new Uint8Array(16+160*120*2),v=new DataView(b.buffer);b.set([83,67,70,87,2,1]);v.setUint16(6,160);v.setUint16(8,120);v.setUint32(10,id);return b;}
async function harness({mode='follow_person',mock=false,controlled=false,big=false,versions}={}){
 const state={presence:.9,x:'right',y:'upper',confidence:.95,delay:50,socialDelay:0},requests=[],sockets=[];
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text+`
export class MixedRoom extends Room {
 constructor(ctx,env){super(ctx,env);this.testEnv=env;}
 async fetch(req){
  const r=await super.fetch(req),path=new URL(req.url).pathname;
  if(path==='/paid-budget'&&this.testEnv.TEST_BUDGET_VERSION){const headers=new Headers(r.headers);headers.set('X-Stackchan-Version',this.testEnv.TEST_BUDGET_VERSION);return new Response(r.body,{status:r.status,headers});}
  if(path==='/list'&&this.testEnv.TEST_ROOM_VERSION){const data=await r.json();data.runtime.version=this.testEnv.TEST_ROOM_VERSION;return Response.json(data);}
  return r;
 }
}`,compatibilityDate:'2026-10-17',log:new Log(LogLevel.NONE),durableObjects:{ROOMS:{className:'MixedRoom',useSQLite:true}},bindings:{TEST_ROOM_VERSION:versions?.room||'',TEST_BUDGET_VERSION:versions?.budget||'',RGB565_BIG_ENDIAN_DEVICES:big?'robot':'',BEHAVIOR_MODE:mode,AI_MODE:mock?'mock':'decisions',ENABLE_PAID_CONTROL:controlled?'true':'false',OPENAI_API_KEY:'fake-only',SESSION_SECRET:'fake-signing',ALLOWED_ORIGIN:origin,ROOM_CONFIG:JSON.stringify({main:{control_token:'fake-control',devices:{robot:'fake-device'},profiles:{robot:'shy'}}}),PAID_SESSION_ID:'follow-test',PAID_SESSION_UNTIL:String(Date.now()+60000),PAID_SESSION_MAX_CALLS:'100',EVAL_INTERVAL_MS:'1000'},outboundService:async request=>{
  assert.ok(['https://api.openai.com/v1/decisions','https://api.openai.com/v1/responses'].includes(request.url));
  const b=await request.json(),perception=b.questions?.[0]?.type==='predicate';requests.push({stage:perception?'perception':b.questions?'intention':'narration',questions:b.questions?.map(q=>q.name)});
  if(perception){const c={...state};await sleep(c.delay);return Response.json({answers:b.questions.map(q=>q.name===c.refusal?{name:q.name,type:'refusal'}:q.type==='predicate'?{name:q.name,type:q.type,probability:q.name==='person_present'?c.presence:.9}:q.type==='score'?{name:q.name,type:q.type,score:2,confidence:.9}:{name:q.name,type:q.type,choice:q.name==='person_horizontal'?c.x:q.name==='person_vertical'?c.y:'neutral',confidence:c.confidence}),usage:{input_tokens:10,output_tokens:0}});}
  await sleep(state.socialDelay);
  if(b.questions)return Response.json({answers:[state.refusal==='intention'?{name:'intention',type:'refusal'}:{name:'intention',type:'choice',choice:'avert',confidence:.95}],usage:{input_tokens:10,output_tokens:0}});
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({thought:'静かに見ている。',public_text:null})}]}],usage:{input_tokens:10,output_tokens:10}});
 }}));
 const login=await mf.dispatchFetch(origin+'/api/control/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({room:'main',token:'fake-control'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const fetch=(path,init)=>mf.dispatchFetch(origin+path,init);
 const post=(path,body,extra={})=>fetch(path,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...extra},body:typeof body==='string'?body:JSON.stringify(body)});
 async function connect(role='device'){
  const r=await fetch(`/ws/${role==='device'?'device':'viewer'}?room=main&device_id=robot${role==='controller'?'&control=1':''}`,{headers:{Upgrade:'websocket',...(role==='device'?{Authorization:'Bearer fake-device'}:{Origin:origin,...(role==='controller'?{Cookie:cookie}:{})})}});assert.equal(r.status,101);
  const ws=r.webSocket,messages=[],frames=[];let jpeg;sockets.push(ws);
  ws.addEventListener('message',e=>{if(typeof e.data==='string')messages.push(JSON.parse(e.data));else{jpeg=new Uint8Array(e.data).slice(4);const id=new DataView(e.data).getUint32(0);frames.push(id);const stream=messages.filter(m=>m.type==='stream').at(-1)?.data.stream_id;if(stream)ws.send(JSON.stringify({type:'frame_ack',timestamp:Date.now(),data:{stream_id:stream,frame_id:id}}));}});ws.accept();
  return {ws,messages,frames,jpeg:()=>jpeg,actions:()=>messages.filter(m=>m.type==='action'),wait:p=>until(()=>messages.find(p)),send:(type,data)=>ws.send(JSON.stringify({type,timestamp:Date.now(),data})),frame:id=>ws.send(raw(id))};
 }
 return {state,requests,fetch,post,connect,head:a=>post('/api/control/head?room=main&device_id=robot',{action:a}),control:c=>post('/api/control/paid-session?room=main',c),health:async()=>await(await fetch('/health')).json(),close:async()=>{for(const ws of sockets)try{ws.close(1000);}catch{}await mf.dispose();}};
}

test('follow moves before slow social requests without FE, shy avert cannot overwrite; autonomous preserves its motion',{timeout:18000},async()=>{
 for(const mode of ['follow_person','autonomous']){const h=await harness({mode});h.state.socialDelay=500;try{
  const d=await h.connect();d.frame(0);const a=await d.wait(m=>m.type==='action');assert.equal((await h.health()).behavior_mode,mode);assert.equal((await d.wait(m=>m.type==='session')).data.behavior_mode,mode);
  assert.equal((await(await h.fetch('/api/rooms/main/devices')).json()).runtime.behavior_mode,mode);
  if(mode==='follow_person'){assert.equal(a.data.action,'look_at');assert.equal(a.data.pan,-.2);assert.equal(a.data.tilt,.16);assert.equal(h.requests.filter(r=>r.stage==='narration').length,0);await sleep(1400);assert.ok(d.actions().every(a=>a.data.pan===-.2&&a.data.tilt===.16&&a.data.action==='look_at'));assert.ok(h.requests[0].questions.includes('person_horizontal'));}
  else{assert.equal(a.data.pan,.35);assert.ok(!h.requests[0].questions.includes('person_horizontal'));}
 }finally{await h.close();}}
});

test('device status telemetry gaps do not close an otherwise open device WebSocket',{timeout:20000},async()=>{
 const h=await harness({mock:true,controlled:true});
 try{
  const d=await h.connect();
  await sleep(15500);
  assert.equal(d.ws.readyState,1);
  assert.equal((await(await h.fetch('/api/rooms/main/devices')).json()).devices[0].online,true);
 }finally{await h.close();}
});

test('Decisions directions reach FW with only pan inverted, tilt unchanged, without FE',{timeout:16000},async()=>{
 for(const [x,y,pan,tilt] of [['left','center',-.2,0],['right','center',.2,0],['center','upper',0,.16],['center','lower',0,-.16],['left','lower',-.2,-.16],['far_left','far_lower',-.4,-.32],['far_left','far_upper',-.4,.32],['far_right','far_lower',.4,-.32],['far_right','far_upper',.4,.32]]){
  const h=await harness();h.state.x=x;h.state.y=y;
  try{const d=await h.connect();d.frame(0);const action=await d.wait(m=>m.type==='action');assert.equal(action.data.pan,pan===0?0:-pan,`image ${x}/${y}: pan`);assert.equal(action.data.tilt,tilt,`image ${x}/${y}: tilt`);}finally{await h.close();}
 }
});

test('local mock follows but controlled API OFF never invents real-device follow or starts upstream',{timeout:12000},async()=>{
 for(const controlled of [false,true]){const h=await harness({mock:true,controlled});try{const d=await h.connect();d.frame(0);if(controlled){await sleep(1300);assert.equal(d.actions().length,0);}else assert.equal((await d.wait(m=>m.type==='action')).data.action,'look_at');assert.equal(h.requests.length,0);}finally{await h.close();}}
});

test('center holds, unknown/no-person suppress steps; contradictory FE coordinates never override Decisions steering',{timeout:22000},async()=>{
 const h=await harness();try{
  const d=await h.connect(),c=await h.connect('controller');d.frame(0);await d.wait(m=>m.type==='action');h.state.x='center';h.state.y='center';d.frame(1);await until(()=>h.requests.filter(r=>r.stage==='perception').length>=2);await sleep(200);assert.ok(d.actions().every(m=>m.data.pan===-.2&&m.data.tilt===.16));
  h.state.x='unknown';h.state.y='unknown';d.frame(2);await until(()=>h.requests.filter(r=>r.stage==='perception').length>=3);await sleep(300);const unknown=d.actions().length;await sleep(300);assert.equal(d.actions().length,unknown);
  h.state.presence=0;d.frame(3);await until(()=>h.requests.filter(r=>r.stage==='perception').length>=4);await sleep(200);const n=d.actions().length,stream=(await c.wait(m=>m.type==='stream'&&m.data.stream_id)).data.stream_id;
  const detect=id=>c.send('detection',{stream_id:stream,frame_id:id,faces:[{id:0,x:0,y:.8,width:.1,height:.1,confidence:.95}],primary_face_id:0});detect(3);await sleep(150);assert.equal(d.actions().length,n);
  h.state.presence=.9;h.state.x='right';h.state.y='upper';d.frame(4);await until(()=>d.actions().length>n);await sleep(150);const pan=d.actions().at(-1).data.pan;const tilt=d.actions().at(-1).data.tilt;for(let i=0;i<4;i++){detect(4);await sleep(120);}assert.equal(d.actions().at(-1).data.pan,pan);assert.equal(d.actions().at(-1).data.tilt,tilt);
  await sleep(6100);h.state.delay=2000;const expired=d.actions().length;d.frame(5);await until(()=>c.frames.includes(5));detect(5);await sleep(250);assert.equal(d.actions().length,expired);
 }finally{await h.close();}
});

test('stop and old streams invalidate early results; final authorized budget slot is still applied',{timeout:16000},async()=>{
 const h=await harness({mock:true,controlled:true});try{
  const d=await h.connect();await h.control({action:'start',seconds:30,max_calls:10});h.state.delay=800;d.frame(0);await until(()=>h.requests.length>0);await h.control({action:'stop'});await sleep(1100);assert.equal(d.actions().length,0);
  await h.control({action:'start',seconds:30,max_calls:10});const count=h.requests.length;d.frame(1);await until(()=>h.requests.length>count);const next=await h.connect();await sleep(1000);assert.equal(next.actions().length,0);
  await h.control({action:'stop'});await h.control({action:'start',seconds:0,max_calls:1});h.state.delay=50;const before=h.requests.length,view=await h.connect('viewer'),completedBefore=(await view.wait(m=>m.type==='telemetry')).data.pipeline_total;next.frame(0);assert.equal((await next.wait(m=>m.type==='action')).data.pan,-.2);assert.equal(h.requests.length,before+1);assert.equal((await h.health()).paid_session.reason,'call_limit');await view.wait(m=>m.type==='telemetry'&&m.data.pipeline_total>completedBefore);assert.equal(view.messages.filter(m=>m.type==='error').length,0);view.send('telemetry_request',{});const t=(await view.wait(m=>m.type==='telemetry_snapshot')).data;assert.equal(t.samples.api.at(-1).outcome,'session_stopped');assert.equal(t.samples.pipelines.at(-1).reason,'paid_session_call_limit');
 }finally{await h.close();}
});

test('manual HTTP enforces auth/origin/input/rate/offline, ACK/seq and keeps its bounded target alive for 10s without API',{timeout:23000},async()=>{
 const h=await harness({mock:true,controlled:true});try{
  const path='/api/control/head?room=main&device_id=robot';assert.equal((await h.fetch(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"action":"left"}'})).status,401);assert.equal((await h.post(path,{action:'left'},{Origin:'https://evil.invalid'})).status,403);assert.equal((await h.head('left')).status,409);
  for(const b of [{action:'bad'},{action:'left',pan:1},null,[]])assert.equal((await h.post(path,b)).status,400);
  assert.equal((await h.post(path,'x'.repeat(1025))).status,413);assert.equal((await h.post(path,{action:'left'},{'Content-Type':'text/plain'})).status,400);assert.equal((await h.post('/api/control/head?room=main&device_id=missing',{action:'left'})).status,404);
  const d=await h.connect();d.frame(0);const left=await(await h.head('left')).json();assert.equal(left.pan,-.2);assert.equal(left.seq,1);assert.ok(left.manual_until>Date.now()+9800);assert.equal((await h.head('up')).status,429);await sleep(120);const up=await(await h.head('up')).json();assert.equal(up.tilt,.2);assert.equal(up.pan,-.2);assert.equal(up.seq,2);
  d.send('action_ack',{seq:up.seq,accepted:true});const viewer=await h.connect('viewer');viewer.send('telemetry_request',{});assert.ok((await viewer.wait(m=>m.type==='telemetry_snapshot')).data.transport.action_ack_rtt.count>0);
  await sleep(10500);assert.ok(d.actions().length>=8);assert.ok(d.actions().slice(1).every(m=>m.data.action==='look_at'&&m.data.pan===.2&&m.data.tilt===.2));const n=d.actions().length;await sleep(1200);assert.equal(d.actions().length,n);assert.equal(h.requests.length,0);
  const center=await(await h.head('center')).json();assert.equal(center.pan,0);assert.equal(center.tilt,0);await sleep(120);const resume=await(await h.head('resume')).json();assert.equal(resume.manual_until,0);assert.equal(resume.seq,center.seq);
 }finally{await h.close();}
});

test('manual targets resist pending follow/social results; reconnect clears manual state and restarts seq',{timeout:15000},async()=>{
 for(const mode of ['follow_person','autonomous']){const h=await harness({mode});h.state.delay=400;h.state.socialDelay=150;try{
  const d=await h.connect();d.frame(0);await until(()=>h.requests.length>0);const manual=await(await h.head('left')).json();await sleep(1200);const resumed=await(await h.head('resume')).json();assert.equal(resumed.pan,manual.pan);assert.equal(resumed.tilt,manual.tilt);assert.ok(d.actions().every(m=>m.data.action==='look_at'&&m.data.pan===.2&&m.data.tilt===0));
  const next=await h.connect();await sleep(120);const center=await(await h.head('center')).json();assert.equal(center.seq,1);assert.equal((await next.wait(m=>m.type==='action'&&m.data.seq===center.seq)).data.pan,0);
 }finally{await h.close();}}
});


test('configured byte-order override reaches the real Worker encoder and telemetry; default LE stays unchanged',{timeout:10000},async()=>{
 let reference;
 for(const big of [false,true]){const h=await harness({mock:true,controlled:true,big});try{
  const d=await h.connect(),v=await h.connect('viewer');const packet=raw(0);
  for(let i=16;i<packet.length;i+=2){packet[i]=big?0xf8:0;packet[i+1]=big?0:0xf8;}d.ws.send(packet);
  await until(()=>v.jpeg());const jpeg=v.jpeg(),image=await sharp(jpeg).raw().toBuffer();assert.ok(image[0]>240&&image[1]<15&&image[2]<15);
  if(reference)assert.deepEqual(jpeg,reference);else reference=jpeg;
  v.send('telemetry_request',{});const t=(await v.wait(m=>m.type==='telemetry_snapshot')).data.transport;assert.equal(t.input_byte_order,big?'big':'little');assert.equal(t.byte_order_override,big);
 }finally{await h.close();}}
});


test('mixed deployments report updating and reject start without a grant; stop remains available',{timeout:12000},async()=>{
 for(const versions of [{room:'old',budget:'local'},{room:'local',budget:'old'}]){
  const h=await harness({controlled:true,mock:true,versions});
  try{
   const before=await h.health();assert.equal(before.deployment.ready,false);assert.equal(before.deployment.worker_version,'local');
   const start=await h.control({action:'start',seconds:0,max_calls:100});assert.equal(start.status,503);assert.equal((await start.json()).error.code,'deployment_updating');
   assert.equal((await h.health()).paid_session.reason,'not_started');assert.equal(h.requests.length,0);
   assert.equal((await h.control({action:'stop'})).status,200);assert.equal((await h.health()).paid_session.reason,'stopped');
  }finally{await h.close();}
 }
});


test('repeated manual targets retain logical state while every wire command inverts only pan',{timeout:10000},async()=>{
 const h=await harness({mock:true,controlled:true});
 try{
  const d=await h.connect();
  for(const [action,pan,tilt] of [['left',-.2,0],['up',-.2,.2],['left',-.4,.2],['right',-.2,.2],['down',-.2,0],['center',0,0]]){
   const r=await h.head(action);assert.equal(r.status,200);const target=await r.json();
   assert.equal(target.pan,pan);assert.equal(target.tilt,tilt);
   const sent=await d.wait(m=>m.type==='action'&&m.data.seq===target.seq);
   assert.equal(sent.data.pan,pan===0?0:-pan);assert.equal(sent.data.tilt,tilt);assert.equal(sent.data.action,'look_at');
   await sleep(120);
  }
  assert.equal(h.requests.length,0);
 }finally{await h.close();}
});

test('refused perception or intention preserves state without FE connection errors and recovers on a new frame',{timeout:25000},async()=>{
 for(const refusal of ['mouth_open','intention']){
  const h=await harness({mode:'autonomous'});h.state.refusal=refusal;
  try{
   const d=await h.connect(),v=await h.connect('viewer');
   const initial=(await v.wait(m=>m.type==='mind')).data;
   d.frame(0);await v.wait(m=>m.type==='telemetry'&&m.data.pipeline_total>0);
   v.send('telemetry_request',{});const stats=(await v.wait(m=>m.type==='telemetry_snapshot')).data;
   assert.equal(stats.samples.pipelines.at(-1).reason,'decisions_refused');assert.equal(stats.samples.pipelines.at(-1).outcome,'discarded');
   assert.equal(stats.samples.api.at(-1).outcome,'refused');assert.equal(stats.samples.api.at(-1).status,200);
   assert.equal(d.actions().length,0);assert.equal(v.messages.filter(m=>m.type==='mind').length,1);assert.equal(v.messages.filter(m=>m.type==='error').length,0);
   assert.equal(v.messages.find(m=>m.type==='mind').data.revision,initial.revision);
   const count=h.requests.length;d.frame(1);await until(()=>v.frames.includes(1));await sleep(500);assert.equal(h.requests.length,count,'no immediate retry');
   if(refusal==='mouth_open'){
    await sleep(10000);assert.equal(h.requests.length,count,'no retry of old image');
    h.state.refusal=null;d.frame(2);await d.wait(m=>m.type==='action');assert.ok(h.requests.length>count);
    assert.equal(v.messages.filter(m=>m.type==='error').length,0);
   }
  }finally{await h.close();}
 }
});

test('explicit unlimited call session reaches upstream and remains manually stoppable without auto-start',{timeout:10000},async()=>{
 const h=await harness({mock:true,controlled:true});
 try{
  const d=await h.connect(),v=await h.connect('viewer');d.frame(0);await sleep(650);assert.equal(h.requests.length,0);
  const grant=await(await h.control({action:'start',seconds:0,max_calls:0})).json();assert.equal(grant.active,true);assert.equal(grant.max_calls,0);
  d.frame(1);await d.wait(m=>m.type==='action');await until(()=>h.requests.length>=3);
  const status=await h.health();assert.equal(status.paid_session.active,true);assert.equal(status.paid_session.max_calls,0);assert.ok(status.paid_session.used_calls>=3);
  await h.control({action:'stop'});const count=h.requests.length;d.frame(2);await sleep(1200);assert.equal(h.requests.length,count);assert.equal((await h.health()).paid_session.reason,'stopped');
  assert.equal(v.messages.filter(m=>m.type==='error').length,0);
 }finally{await h.close();}
});
