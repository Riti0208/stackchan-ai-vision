import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/connection.ts',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'browser'});
function harness(){
 const module={exports:{}},workers=[],decodes=[],sent=[],drawn=[];
 let now=1000;
 class Worker{constructor(){workers.push(this)}postMessage(d){this.last=d}terminate(){}}
 runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,location:{search:'',href:'https://test.invalid/',origin:'https://test.invalid',protocol:'https:'},URL,URLSearchParams,Worker,WebSocket:{OPEN:1},AbortController,AbortSignal,TextEncoder,ArrayBuffer,Uint8Array,DataView,Blob,Date,performance:{now:()=>now},setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){},createImageBitmap:()=>new Promise((resolve,reject)=>decodes.push({resolve,reject}))});
 const c=new module.exports.RobotConnection();c.health=()=>{};c.connect=()=>{};c.start();
 c.state={...c.state,online:true,role:'controller',stream:'s',vision:'ready'};
 c.ws={readyState:1,send:s=>sent.push(JSON.parse(s))};
 c.setCanvas({width:160,height:120,getContext:()=>({drawImage:b=>drawn.push(b),clearRect(){}})});
 const packet=id=>{const b=new ArrayBuffer(8);new DataView(b).setUint32(0,id);new Uint8Array(b).set([255,216,255,217],4);return b};
 const flush=async()=>{await Promise.resolve();await Promise.resolve()};
 return {c,sent,drawn,workers,frame:id=>c.receiveFrame(packet(id)),tick:()=>now+=600,async decode(){const b={width:160,height:120,closed:false,close(){this.closed=true}};decodes.shift().resolve(b);await flush();return b}};
}
test('continuous ingress draws completed frames and cumulatively ACKs past skipped pending images',async()=>{
 const h=harness();h.frame(1);
 for(let id=2;id<=10;id++){h.frame(id);await h.decode()}
 assert.equal(h.drawn.length,9);
 assert.deepEqual(h.sent.filter(m=>m.type==='frame_ack').map(m=>m.data.frame_id),[1,2,3,4,5,6,7,8,9]);
 h.frame(11);h.frame(12);await h.decode();await h.decode();
 assert.equal(h.sent.at(-1).data.frame_id,12);
 assert.ok(!h.sent.some(m=>m.type==='frame_ack'&&m.data.frame_id===11));
});
test('recent detection is sent for control while overlays stay attached to the displayed frame',async()=>{
 const h=harness();h.frame(1);await h.decode();const d=h.workers[0].last;
 h.frame(2);await h.decode();
 const faces=[{id:0,x:.1,y:.2,width:.2,height:.3,confidence:.9}];
 h.workers[0].onmessage({data:{...d,type:'result',faces,primary:0}});
 assert.equal(h.sent.at(-1).type,'detection');assert.equal(h.sent.at(-1).data.frame_id,1);
 assert.equal(h.c.state.faces.length,0,'old-frame overlays must remain hidden');
});
test('current detection paints overlays; stale generations and streams send nothing',async()=>{
 const h=harness();h.frame(1);await h.decode();const d=h.workers[0].last;
 const faces=[{id:0,x:.1,y:.2,width:.2,height:.3,confidence:.9}];
 for(const patch of [{generation:d.generation-1},{stream:'old'}])h.workers[0].onmessage({data:{...d,...patch,type:'result',faces,primary:0}});
 assert.equal(h.sent.filter(m=>m.type==='detection').length,0);
 h.workers[0].onmessage({data:{...d,type:'result',faces,primary:0}});
 assert.equal(h.c.state.faces.length,1);assert.equal(h.sent.at(-1).type,'detection');
});
test('stream replacement while decoding closes old bitmap without ACK or draw',async()=>{
 const h=harness();h.frame(1);h.c.clearStream();h.c.state={...h.c.state,stream:'next'};
 const bitmap=await h.decode();assert.equal(bitmap.closed,true);
 assert.equal(h.drawn.length,0);assert.equal(h.sent.length,0);
});
