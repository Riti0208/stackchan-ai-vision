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
 assert.deepEqual(pacing({STREAM_FPS:'-3',EVAL_INTERVAL_MS:'NaN',NARRATION_INTERVAL_MS:'0'}),pacing({}));assert.equal(pacing({STREAM_FPS:'4'}).stream_fps,4);assert.equal(pacing({EVAL_INTERVAL_MS:'500'}).evaluation_interval_ms,500);
});
