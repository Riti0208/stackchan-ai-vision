import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toDeviceMotion} from '../src/device-motion.ts';
import {manualTarget,coarseTarget} from '../src/follow-person.ts';
test('all action kinds adapt only pan without mutating logical pose or other wire fields',()=>{
 for(const action of ['idle','look_at','nod','shake','happy'])for(const pan of [-1,-.2,0,.2,1])for(const tilt of [-1,0,1]){
  const logical=Object.freeze({seq:23,action,pan,tilt,expression:'thinking',duration_ms:500});
  const wire=toDeviceMotion(logical);assert.deepEqual(wire,{...logical,pan:pan===0?0:-pan});assert.equal(logical.pan,pan);assert.equal(Object.is(wire.pan,-0),false);
 }
});
test('image left/lower and repeated manual left preserve down and adapt legacy FW yaw',()=>{
 const target=coarseTarget(0,0,{horizontal:{label:'left',confidence:.9},vertical:{label:'lower',confidence:.9}});
 const wire=toDeviceMotion({seq:1,action:'look_at',...target,expression:'thinking',duration_ms:250});
 assert.equal(wire.pan,.2);assert.equal(wire.tilt,-.16);
 // Unmodified FW Behavior scales pan*30deg then moveHead negates yaw.
 assert.equal(-wire.pan*30,-6);assert.ok(Math.abs(wire.tilt*15+2.4)<1e-9);
 let logical={pan:0,tilt:.2};
 for(let i=0;i<2;i++)logical=manualTarget(logical.pan,logical.tilt,'left');
 const second=toDeviceMotion({seq:2,action:'look_at',...logical,expression:'neutral',duration_ms:500});
 assert.equal(logical.pan,-.4);assert.equal(second.pan,.4);assert.equal(second.tilt,.2);
});
