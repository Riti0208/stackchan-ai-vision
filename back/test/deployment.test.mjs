import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deploymentStatus} from '../src/deployment.ts';
test('deployment readiness requires exact worker, room and budget versions; legacy headers fail closed',()=>{
 assert.equal(deploymentStatus('new','new','new').ready,true);
 for(const [room,budget] of [['old','new'],['new','old'],['old','old'],[null,'new'],['new',null]])assert.equal(deploymentStatus('new',room,budget).ready,false);
});
