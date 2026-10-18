import {test} from 'node:test';
import assert from 'node:assert/strict';
import {logConnection, logRun, logTransport} from '../src/observability.ts';
import {snapshot,newHistory,newTransport,pacing} from '../src/telemetry.ts';
test('structured diagnostics preserve correlation and allowlist metadata without sensitive content',()=>{
  const output=[], original=console.log; console.log=value=>output.push(value);
  try {
    const context={room:'main',id:'robot',stream:'stream',token:'secret-token',thought:'private-thought'};
    logConnection(context,true);
    logRun(context,{id:'run',frame_id:2,outcome:'error',reason:'api_error',duration_ms:42,prompt:'secret-prompt',api:[{stage:'perception',endpoint:'decisions',model:'model',request_id:'req',status:503,outcome:'http_error',rtt_ms:42,input_tokens:1,output_tokens:0,body:'secret-body'}]});
    logTransport(context,snapshot(newHistory(),newTransport('stream'),pacing({})));
    assert.deepEqual(output.map(v=>v.event),['device_connection','openai_call','pipeline_completed','device_transport']);
    assert.equal(output[1].room,'main');assert.equal(output[1].run_id,'run');assert.equal(output[1].status,503);
    assert.doesNotMatch(JSON.stringify(output),/secret-|private-thought|prompt|body/);
  } finally {console.log=original;}
});
