// Local workerd only: no credentials, OpenAI calls, or public endpoint.
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
const built = await build({ stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
import { parseRawFrame, encodeRawFrame } from './src/raw-frame.ts';
export default { async fetch(request) {
 const raw = parseRawFrame(await request.arrayBuffer()); if (!raw) return new Response('invalid', {status:400});
 const n = Math.min(100, Math.max(1,Number(new URL(request.url).searchParams.get('n'))||1)), samples=[];let bytes=0;
 for(let i=0;i<n;i++){const start=performance.now();bytes=encodeRawFrame(raw).length;samples.push(performance.now()-start);}
 return Response.json({samples,bytes});
}};` }, bundle: true, format: 'esm', platform: 'browser', write: false, minify: true });
const script = built.outputFiles[0].text;
const mf = new Miniflare(convertV4MiniflareOptions({ name:'raw-benchmark', modules:true, script, compatibilityDate:'2026-10-17', inspectorPort:0, log:new Log(LogLevel.ERROR) }));
let inspector;
const results={ runtime:'local workerd (Miniflare)', bundle_bytes:Buffer.byteLength(script), bundle_gzip_bytes:gzipSync(script).length, samples_per_scene:1000, scenes:[] };
try {
 await mf.ready;
 const warmPacket=new Uint8Array(38416),wv=new DataView(warmPacket.buffer);warmPacket.set([83,67,70,87,2,1]);wv.setUint16(6,160);wv.setUint16(8,120);
 const first=await(await mf.dispatchFetch('http://local/?n=1',{method:'POST',body:warmPacket})).json();
 results.initial_encode_ms=first.samples[0];
 const inspectorURL=await mf.getInspectorURL();inspectorURL.protocol='http:';
 const targets=await(await fetch(new URL('/json/list',inspectorURL))).json();
 inspector = new WebSocket(targets[0].webSocketDebuggerUrl); await once(inspector,'open');
 let next=0;const callbacks=new Map();
 inspector.on('message',data=>{const m=JSON.parse(data);const callback=callbacks.get(m.id);if(callback){callbacks.delete(m.id);m.error?callback.reject(Error(m.error.message)):callback.resolve(m.result);}});
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{callbacks.delete(id);reject(Error('Inspector timeout: '+method));},8000);callbacks.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});inspector.send(JSON.stringify({id,method,params}));});
 await cdp('Runtime.enable');
 const heap=()=>cdp('Runtime.getHeapUsage');
 results.heap_before=await heap();let peak=results.heap_before.usedSize;
 for(const scene of ['solid','gradient','noise']){
  const packet=new Uint8Array(38416),v=new DataView(packet.buffer);packet.set([83,67,70,87,2,1]);v.setUint16(6,160);v.setUint16(8,120);
  let seed=12345;for(let i=16;i<packet.length;i+=2){seed=(Math.imul(seed,1664525)+1013904223)>>>0;v.setUint16(i,scene==='solid'?0xf800:scene==='gradient'?((i/2)&65535):seed&65535,true);}
  const cold=await (await mf.dispatchFetch('http://local/?n=1',{method:'POST',body:packet})).json();
  const samples=[];const start=performance.now();let bytes=0;
  for(let i=0;i<10;i++){const r=await(await mf.dispatchFetch('http://local/?n=100',{method:'POST',body:packet})).json();samples.push(...r.samples);bytes=r.bytes;peak=Math.max(peak,(await heap()).usedSize);}
  samples.sort((a,b)=>a-b);results.scenes.push({scene,raw_bytes:packet.length,jpeg_packet_bytes:bytes,first_scene_ms:cold.samples[0],warm_p50_ms:samples[499],warm_p95_ms:samples[949],warm_max_ms:samples[999],batch_wall_ms:performance.now()-start});
 }
 results.heap_after=await heap();results.heap_sampled_peak_bytes=peak;
 // HeapProfiler.collectGarbage is unavailable in workerd's Inspector; report observed heaps without forcing GC.
 console.log(JSON.stringify(results,null,2));
} finally { inspector?.close(); await mf.dispose(); }
