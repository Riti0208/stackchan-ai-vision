import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import sharp from 'sharp';
const origin='https://conversion-test.invalid',root=fileURLToPath(new URL('../',import.meta.url));
// Replace only the existing scheduler yield after encoding with controlled I/O.
// Production has no test setting and sends no additional upstream requests.
const bundle=await build({absWorkingDir:root,entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'controlled-encode-yield',setup(b){b.onLoad({filter:/\/src\/index\.ts$/},async args=>{
 const source=await readFile(args.path,'utf8'),needle='await new Promise<void>(resolve => setTimeout(resolve, 0));';
 assert.equal(source.split(needle).length,2,'exactly one post-encode yield');
 return {contents:source.replace(needle,"await fetch('https://conversion-barrier.invalid/yield');"),loader:'ts'};
});}}]});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,timeout=4000){const end=Date.now()+timeout;while(Date.now()<end){const result=test();if(result)return result;await sleep(5);}assert.fail('Conversion progress condition timed out');}
function raw(id){const bytes=new Uint8Array(38416),v=new DataView(bytes.buffer);bytes.set([83,67,70,87,2,1]);v.setUint16(6,160);v.setUint16(8,120);v.setUint32(10,id);for(let i=16;i<bytes.length;i+=2){bytes[i]=0;bytes[i+1]=0xf8;}return bytes;}
async function harness(){
 const gates=[],sockets=[];let closing=false;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-17',log:new Log(LogLevel.NONE),durableObjects:{ROOMS:{className:'Room',useSQLite:true}},bindings:{AI_MODE:'mock',ENABLE_PAID_CONTROL:'true',SESSION_SECRET:'fake',ALLOWED_ORIGIN:origin,STREAM_FPS:'1',ROOM_CONFIG:JSON.stringify({main:{control_token:'fake-control',devices:{robot:'fake-device'}}})},outboundService:async request=>{
  assert.equal(request.url,'https://conversion-barrier.invalid/yield','no OpenAI or other upstream requests');
  if(!closing)await new Promise(resolve=>gates.push(resolve));return new Response(null,{status:204});
 }}));
 async function connect(device=false){
  const r=await mf.dispatchFetch(origin+`/ws/${device?'device':'viewer'}?room=main&device_id=robot`,{headers:{Upgrade:'websocket',...(device?{Authorization:'Bearer fake-device'}:{Origin:origin})}});assert.equal(r.status,101);
  const ws=r.webSocket,messages=[],frames=[],packets=[];let stream=null;sockets.push(ws);
  const send=(type,data)=>ws.send(JSON.stringify({type,timestamp:Date.now(),data}));
  ws.addEventListener('message',e=>{if(typeof e.data==='string'){const m=JSON.parse(e.data);messages.push(m);if(m.type==='stream')stream=m.data.stream_id;}else{const id=new DataView(e.data).getUint32(0);frames.push(id);packets.push(new Uint8Array(e.data));send('frame_ack',{stream_id:stream,frame_id:id});}});ws.accept();
  return {ws,messages,frames,packets,send,frame:id=>ws.send(raw(id)),wait:predicate=>until(()=>messages.find(predicate))};
 }
 return {connect,gates,release:i=>gates[i](),gate:n=>until(()=>gates.length>=n),async close(){closing=true;for(const release of gates)release();for(const ws of sockets)try{ws.close(1000);}catch{}await mf.dispose();}};
}
async function stats(view){view.send('telemetry_request',{});return (await view.wait(m=>m.type==='telemetry_snapshot')).data.transport;}
test('completed JPEG publishes despite newer ingress, then the next JPEG publishes in order',{timeout:10000},async()=>{
 const h=await harness();try{
  const d=await h.connect(true),v=await h.connect();d.frame(10);await h.gate(1);
  d.frame(11);await d.wait(m=>m.type==='frame_received'&&m.data.frame_id===11);
  h.release(0);await h.gate(2);await until(()=>v.frames.includes(10),800);
  assert.deepEqual(v.frames,[10],'first JPEG must publish before releasing the next encode');
  h.release(1);await until(()=>v.frames.length===2);assert.deepEqual(v.frames,[10,11]);
  for(const packet of v.packets){const image=await sharp(packet.subarray(4)).metadata();assert.equal(image.width,160);assert.equal(image.height,120);}
  const t=await stats(v);assert.equal(t.frames_received,2);assert.equal(t.conversion.converted_total,2);assert.equal(t.conversion.published_total,2);assert.equal(t.conversion.dropped_total,0);
 }finally{await h.close();}
});
test('a burst replaces only pending raw; completed JPEG still publishes and newest pending follows',{timeout:10000},async()=>{
 const h=await harness();try{
  const d=await h.connect(true),v=await h.connect();d.frame(1);await h.gate(1);
  for(let id=2;id<=50;id++)d.frame(id);await d.wait(m=>m.type==='frame_received'&&m.data.frame_id===50);
  h.release(0);await h.gate(2);await until(()=>v.frames.includes(1));h.release(1);await until(()=>v.frames.length===2);
  assert.deepEqual(v.frames,[1,50]);const t=await stats(v);assert.equal(t.frames_received,50);assert.equal(t.conversion.converted_total,2);assert.equal(t.conversion.published_total,2);assert.equal(t.conversion.dropped_total,48);
 }finally{await h.close();}
});
test('in-flight JPEG from replaced device never leaks into the new stream',{timeout:10000},async()=>{
 const h=await harness();try{
  const old=await h.connect(true),v=await h.connect();old.frame(10);await h.gate(1);
  const replacement=await h.connect(true);replacement.frame(20);await replacement.wait(m=>m.type==='frame_received'&&m.data.frame_id===20);
  h.release(0);await h.gate(2);assert.deepEqual(v.frames,[]);h.release(1);await until(()=>v.frames.length===1);assert.deepEqual(v.frames,[20]);
 }finally{await h.close();}
});
test('expired completed JPEG remains discarded',{timeout:10000},async()=>{
 const h=await harness();try{
  const d=await h.connect(true),v=await h.connect();d.frame(1);await h.gate(1);await sleep(3100);h.release(0);await sleep(150);
  assert.deepEqual(v.frames,[]);const t=await stats(v);assert.equal(t.conversion.converted_total,1);assert.equal(t.conversion.published_total,0);assert.equal(t.conversion.dropped_total,1);
 }finally{await h.close();}
});
test('FE publishing has no STREAM_FPS cap and frame-ID wrap retains ingress order',{timeout:10000},async()=>{
 const h=await harness();try{
  const d=await h.connect(true),v=await h.connect(),ids=[0xfffffffe,0xffffffff,0,1,2];
  for(let i=0;i<ids.length;i++){d.frame(ids[i]);await h.gate(i+1);h.release(i);await until(()=>v.frames.length===i+1);}
  assert.deepEqual(v.frames,ids);const t=await stats(v);assert.equal(t.conversion.published_total,ids.length);assert.equal(t.conversion.dropped_total,0);
 }finally{await h.close();}
});
