import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stats,newHistory,newTransport,recordRun,receiveFrame,addSample,pacing,snapshot} from '../src/telemetry.ts';
const api=(stage,at=0,stream='s')=>({stage,started_at:at,completed_at:at+100,stream_id:stream,rtt_ms:100,outcome:'success'});
const run=(id, samples=[])=>({id,stream_id:'s',frame_id:1,frame_received_at:0,started_at:100,completed_at:200,duration_ms:100,outcome:'committed',reason:'accepted',api:samples});
test('percentiles use bounded real samples and empty RTTs stay null',()=>{assert.deepEqual(stats([]),{count:0,p50_ms:null,p95_ms:null,max_ms:null});assert.equal(stats([10,20,30,40,100]).p95_ms,100);const x=[];for(let i=0;i<200;i++)addSample(x,i);assert.equal(x.length,120);assert.equal(x[0],80);});
test('recorded API and pipeline histories are bounded, totals include failures and discarded attempts',()=>{
 const h=newHistory();for(let i=0;i<200;i++)recordRun(h,{...run(String(i),[{...api('perception'),outcome:i%2?'http_error':'success'}]),outcome:i%3?'committed':'discarded'});
 assert.equal(h.api.length,120);assert.equal(h.pipelines.length,60);assert.equal(h.api_attempts_total,200);assert.equal(h.pipeline_total,200);assert.ok(!('api' in h.pipelines[0]));
});
test('API cadence is stage-specific and never bridges stream reconnect gaps',()=>{
 const h=newHistory(),t=newTransport('s');recordRun(h,run('1',[api('perception',1000),api('intention',1500),api('perception',3000),api('narration',3500),api('perception',90000,'old')]));
 const out=snapshot(h,t,pacing({}),100000);assert.equal(out.stages.perception.interval.p50_ms,2000);assert.equal(out.stages.intention.interval.count,0);
});
test('received FPS is computed from ingress samples, independently of API intervals',()=>{
 const h=newHistory(),t=newTransport('s');for(let i=0;i<5;i++)receiveFrame(t,1000,1000+i*250);
 const out=snapshot(h,t,pacing({STREAM_FPS:'4',EVAL_INTERVAL_MS:'1500'}),2000);assert.equal(out.transport.received_fps,4);assert.equal(out.transport.frame_interval.p50_ms,250);assert.equal(out.pacing.evaluation_interval_ms,1500);assert.equal(out.stages.perception.count,0);
});
test('pacing is bounded and invalid or missing configuration uses known defaults',()=>{
 assert.deepEqual(pacing({STREAM_FPS:'-3',EVAL_INTERVAL_MS:'NaN',NARRATION_INTERVAL_MS:'0'}),pacing({}));assert.equal(pacing({}).stream_fps,60);assert.equal(pacing({}).evaluation_interval_ms,1000);assert.equal(pacing({STREAM_FPS:'60'}).stream_fps,60);assert.equal(pacing({STREAM_FPS:'61'}).stream_fps,60);assert.equal(pacing({STREAM_FPS:'4'}).stream_fps,4);assert.equal(pacing({EVAL_INTERVAL_MS:'500'}).evaluation_interval_ms,500);
});


// Cover the viewer window in the normal unit gate, without a Worker or API calls.
import {FrameWindow, VIEWER_MAX_FRAMES, VIEWER_MAX_BYTES, VIEWER_ACK_TIMEOUT_MS} from '../src/frame-window.ts';
test('60fps relay tolerates 250ms ACK latency without dropping a frame',()=>{
 const window=new FrameWindow(), queued=[];
 for(let id=0;id<600;id++){
  const at=id*1000/60;
  while(queued.length && queued[0].at<=at){const ack=queued.shift();assert.ok(window.acknowledge(ack.id,at)>=250-1e-6);}
  assert.equal(window.canSend(64*1024,at),true);window.sent(id,64*1024,at);queued.push({id,at:at+250});
 }
});
test('unacknowledged frames have independent frame, byte and elapsed-time bounds',()=>{
 const count=new FrameWindow();for(let i=0;i<VIEWER_MAX_FRAMES;i++){assert.ok(count.canSend(8,0));count.sent(i,8,0);}
 assert.equal(count.canSend(8,0),false);
 const bytes=new FrameWindow();for(let i=0;i<32;i++){assert.ok(bytes.canSend(256*1024,0));bytes.sent(i,256*1024,0);}
 assert.equal(bytes.canSend(1,0),false);assert.equal(VIEWER_MAX_BYTES,32*256*1024);
 const timed=new FrameWindow();timed.sent(1,8,50);
 assert.equal(timed.expired(50+VIEWER_ACK_TIMEOUT_MS-1),false);assert.equal(timed.expired(50+VIEWER_ACK_TIMEOUT_MS),true);
 assert.equal(timed.canSend(8,50+VIEWER_ACK_TIMEOUT_MS),false);
 assert.equal(new FrameWindow().expired(999999),false);
});
test('cumulative ACK releases exact bytes in send order across uint32 wrap, ignoring unknown and duplicate IDs',()=>{
 const window=new FrameWindow();
 window.sent(0xffffffff,VIEWER_MAX_BYTES-8,100);window.sent(0,8,120);
 assert.equal(window.acknowledge(42,130),undefined);assert.equal(window.canSend(1,130),false);
 assert.equal(window.acknowledge(0,150),30);assert.equal(window.acknowledge(0,160),undefined);
 assert.equal(window.canSend(VIEWER_MAX_BYTES,160),true);
 window.sent(1,VIEWER_MAX_BYTES-8,170);window.sent(2,8,180);
 assert.equal(window.acknowledge(1,190),20);assert.equal(window.canSend(VIEWER_MAX_BYTES-8,190),true);assert.equal(window.canSend(VIEWER_MAX_BYTES,190),false);
 assert.equal(window.expired(180+VIEWER_ACK_TIMEOUT_MS),true);
 window.clear();assert.equal(window.expired(999999),false);assert.equal(window.canSend(VIEWER_MAX_BYTES,999999),true);assert.equal(window.acknowledge(2,999999),undefined);
});
test('ingress history stays bounded and preserves chronological FPS samples',()=>{
 const t=newTransport('s'),samples=t.frames;for(let id=0;id<1000;id++)receiveFrame(t,id,id*1000/60);
 assert.equal(t.frames,samples);assert.equal(t.frames.length,120);assert.equal(t.frames[0].bytes,880);
 assert.equal(t.received_total,1000);assert.equal(t.bytes_total,999*1000/2);
 assert.equal(snapshot(newHistory(),t,pacing({}),1000*1000/60).transport.received_fps,60);
});
