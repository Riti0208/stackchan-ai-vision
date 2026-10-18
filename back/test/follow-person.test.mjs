import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualTarget, behaviorMode, coarseTarget, followFresh, FOLLOW_MAX_AGE_MS } from '../src/follow-person.ts';
import { evaluationPayload, parseEvaluation, visibleQuestions, emotionKeys, mockEvaluation } from '../src/perception.ts';
const position=(x,y,confidence=.9)=>({horizontal:{label:x,confidence},vertical:{label:y,confidence}});
const initial={happiness:.5,curiosity:.5,excitement:.5,shyness:.5,trust:.5};
function body(x='right',y='upper'){return {answers:[...visibleQuestions.map(([name])=>({name,type:'predicate',probability:.9})),{name:'apparent_expression',type:'choice',choice:'neutral',confidence:.9},...emotionKeys.map(name=>({name:`affect_${name}`,type:'score',score:2,confidence:.9})),{name:'person_horizontal',type:'choice',choice:x,confidence:.9},{name:'person_vertical',type:'choice',choice:y,confidence:.9}]};}
test('follow adds two coarse choices to the same perception request; autonomous retains its original questions',()=>{
 const old=evaluationPayload('data:image/jpeg;base64,fake',{},[],false),follow=evaluationPayload('data:image/jpeg;base64,fake',{},[],false,true);
 assert.equal(old.questions.length,14);assert.equal(follow.questions.length,16);assert.equal(follow.input[0].content.filter(c=>c.type==='input_image').length,1);
 assert.ok(follow.questions.find(q=>q.name==='person_horizontal').instructions.includes('40%-60%'));
 for(const name of ['person_horizontal','person_vertical']) { const instructions=follow.questions.find(q=>q.name===name).instructions; assert.ok(instructions.includes('Do not mirror or rotate')); assert.ok(instructions.includes('top-left corner as origin')); assert.ok(instructions.includes('bottom-left corner must yield far_left for horizontal and far_lower for vertical')); assert.ok(instructions.includes('not bounding boxes or motor angles')); }
 assert.deepEqual(parseEvaluation(body(),true).position,position('right','upper'));
 for(const edit of [b=>b.answers.pop(),b=>b.answers.at(-1).choice='invented',b=>b.answers.at(-1).confidence=NaN,b=>b.answers.push(b.answers.at(-1))]){const b=body();edit(b);assert.throws(()=>parseEvaluation(b,true));}
 assert.equal(parseEvaluation(body()).position,undefined);
});
test('coarse steering directions, center hold, per-axis uncertainty and safety clamps',()=>{
 assert.deepEqual(coarseTarget(0,0,position('left','lower')),{pan:-.2,tilt:-.16});assert.deepEqual(coarseTarget(0,0,position('right','upper')),{pan:.2,tilt:.16});
 assert.deepEqual(coarseTarget(.3,-.2,position('center','center')),{pan:.3,tilt:-.2});assert.equal(coarseTarget(0,0,position('right','upper',.2)),null);
 assert.equal(coarseTarget(0,0,position('unknown','unknown')),null);assert.deepEqual(coarseTarget(.99,-.99,position('right','lower')),{pan:1,tilt:-1});
 assert.deepEqual(coarseTarget(0,0,{horizontal:{label:'right',confidence:.2},vertical:{label:'upper',confidence:.9}}),{pan:0,tilt:.16});
 assert.equal(coarseTarget(NaN,0,position('right','upper')),null);
});
test('all four image quadrants preserve their pan/tilt direction through response parsing',()=>{
 for(const [x,y,sx,sy] of [['left','lower',-1,-1],['left','upper',-1,1],['right','lower',1,-1],['right','upper',1,1]]){
  const parsed=parseEvaluation(body(x,y),true),target=coarseTarget(0,0,parsed.position);
  assert.equal(Math.sign(target.pan),sx);assert.equal(Math.sign(target.tilt),sy);
 }
 // Tracking is an incremental correction; a previous right/up target may
 // remain right/up after one left/down correction, but both values decrease.
 const target=coarseTarget(.8,.8,position('left','lower'));
 assert.ok(target.pan<.8&&target.tilt<.8);assert.ok(target.pan>0&&target.tilt>0);
});
test('presence permission expires from image receive time and never crosses streams/session deadlines',()=>{
 const gate={stream:'s',order:1,frameAt:1000,until:1000+FOLLOW_MAX_AGE_MS};assert.equal(followFresh(gate,'s',6999),true);assert.equal(followFresh(gate,'s',7000),false);
 assert.equal(followFresh(gate,'old',2000),false);assert.equal(followFresh(undefined,'s',2000),false);assert.equal(followFresh({...gate,until:1500},'s',1500),false);
 assert.equal(behaviorMode({BEHAVIOR_MODE:'follow_person'}),'follow_person');assert.equal(behaviorMode({BEHAVIOR_MODE:'autonomous'}),'autonomous');assert.equal(behaviorMode({BEHAVIOR_MODE:'bad'}),'autonomous');
 assert.ok(mockEvaluation(0,initial,'shy',false,[],true).position);assert.equal(mockEvaluation(0,initial,'shy',false,[]).position,undefined);
});

test('manual direction increments and center are bounded absolute targets',()=>{
 assert.deepEqual(manualTarget(0,0,'left'),{pan:-.2,tilt:0});assert.deepEqual(manualTarget(0,0,'right'),{pan:.2,tilt:0});
 assert.deepEqual(manualTarget(0,0,'up'),{pan:0,tilt:.2});assert.deepEqual(manualTarget(0,0,'down'),{pan:0,tilt:-.2});
 assert.deepEqual(manualTarget(.99,-.99,'right'),{pan:1,tilt:-.99});assert.deepEqual(manualTarget(-.99,-.99,'down'),{pan:-.99,tilt:-1});
 assert.deepEqual(manualTarget(.8,-.6,'center'),{pan:0,tilt:0});
});

test('five image bands choose smaller near-center steps and larger edge steps on each axis',()=>{
 const xs=[['far_left',-.4],['left',-.2],['center',0],['right',.2],['far_right',.4]];
 const ys=[['far_lower',-.32],['lower',-.16],['center',0],['upper',.16],['far_upper',.32]];
 for(const [x,pan] of xs)for(const [y,tilt] of ys){
  const parsed=parseEvaluation(body(x,y),true);
  assert.deepEqual(coarseTarget(0,0,parsed.position),{pan,tilt});
 }
 assert.deepEqual(coarseTarget(.9,-.9,position('far_right','far_lower')),{pan:1,tilt:-1});
 assert.equal(coarseTarget(0,0,position('far_left','far_lower',.64)),null);
 const q=evaluationPayload('data:image/jpeg;base64,fake',{},[],false,true).questions;
 assert.deepEqual(q.find(q=>q.name==='person_horizontal').choices.map(c=>c.value),[...xs.map(([label])=>label),'unknown']);
 assert.deepEqual(q.find(q=>q.name==='person_vertical').choices.map(c=>c.value),['far_upper','upper','center','lower','far_lower','unknown']);
 assert.deepEqual(mockEvaluation(0,initial,'shy',false,[],true).position,position('center','center',.95));
});
