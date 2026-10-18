import {test} from 'node:test';
import assert from 'node:assert/strict';
import {logCloseRequested, logConnection, logRun, logTransport} from '../src/observability.ts';
import {snapshot,newHistory,newTransport,pacing} from '../src/telemetry.ts';
test('structured diagnostics preserve correlation and allowlist metadata without sensitive content',()=>{
  const output=[], original=console.log; console.log=value=>output.push(value);
  try {
    const context={room:'main',id:'robot',stream:'stream',token:'secret-token',thought:'private-thought'};
    logConnection(context,true);
    logConnection(context,false,{code:4000,reason:'status_timeout'});
    logCloseRequested(context,'device',4000,'status_timeout');
    logRun(context,{id:'run',frame_id:2,outcome:'error',reason:'api_error',duration_ms:42,prompt:'secret-prompt',api:[{stage:'perception',endpoint:'decisions',model:'model',request_id:'req',status:503,outcome:'http_error',rtt_ms:42,input_tokens:1,output_tokens:0,body:'secret-body'}]});
    logTransport(context,snapshot(newHistory(),newTransport('stream'),pacing({})));
    assert.deepEqual(output.map(v=>v.event),['device_connection','device_connection','peer_close_requested','openai_call','pipeline_completed','device_transport']);
    assert.equal(output[1].close_code,4000);assert.equal(output[1].close_reason,'status_timeout');
    assert.equal(output[2].role,'device');assert.equal(output[2].reason,'status_timeout');
    assert.equal(output[3].room,'main');assert.equal(output[3].run_id,'run');assert.equal(output[3].status,503);
    assert.doesNotMatch(JSON.stringify(output),/secret-|private-thought|prompt|body/);
  } finally {console.log=original;}
});
