import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialHumanActions, scanHumanActions, consumeHumanAction} from '../src/human-actions.ts';
const observation = (overrides={}) => ({ person_present: .99, waving: .05, smiling: .05, frowning: .05, eyes_wide: .05, mouth_open: .05, tears_visible: .05, looking_at_robot: .05, ...overrides });
function tracker(saved) { let state=initialHumanActions(saved), order=0, at=10000;return { get state(){return state;}, next(o, extra={}) { const result=scanHumanActions(state,o,{stream_id:'stream',frame_id:order,order:order++,at:at+=2000,...extra});state=result.state;return result; } }; }
test('new hand pose requires two confident distinct frames and is not repeated after expiry',()=>{
 const t=tracker();t.next(observation());t.next(observation());t.state.pending=[];
 assert.equal(t.next(observation({waving:.99})).created,null);
 const event=t.next(observation({waving:.99})).created;assert.deepEqual(event.changes,['hand_raised']);consumeHumanAction(t.state,event.id);
 for(let i=0;i<10;i++)assert.equal(t.next(observation({waving:.99})).created,null);
 assert.equal(t.state.pending.length,0);
});
test('uncertain samples and duplicate frame orders do not confirm an action',()=>{
 const t=tracker();t.next(observation());t.next(observation());t.state.pending=[];
 t.next(observation({waving:.99}));assert.equal(t.next(observation({waving:.99}),{order:2}).created,null);
 t.next(observation({waving:.55}));assert.equal(t.next(observation({waving:.99})).created,null);
 assert.ok(t.next(observation({waving:.99})).created.changes.includes('hand_raised'));
});
test('two clear releases rearm a gesture; ambiguous or single release does not',()=>{
 const t=tracker();t.next(observation({waving:.99}));t.next(observation({waving:.99}));
 t.next(observation({waving:.05}));t.next(observation({waving:.99}));assert.equal(t.next(observation({waving:.99})).created,null);
 t.next(observation());t.next(observation());t.next(observation({waving:.99}));assert.deepEqual(t.next(observation({waving:.99})).created.changes,['hand_raised']);
});
test('drawn faces without a person do not create smile or tear events',()=>{
 const t=tracker();t.next(observation({person_present:0,smiling:1,tears_visible:1}));assert.equal(t.next(observation({person_present:0,smiling:1,tears_visible:1})).created,null);
});
test('reconnect retains active cues but drops pending events and partial evidence',()=>{
 const t=tracker();t.next(observation({waving:.99}));t.next(observation({waving:.99}));assert.ok(t.state.pending.length);
 const resumed=tracker(t.state);assert.equal(resumed.state.pending.length,0);resumed.next(observation({waving:.99}));assert.equal(resumed.next(observation({waving:.99})).created,null);
});
test('long observation gaps reset confirmation and pending events have a bounded lifetime',()=>{
 const t=tracker();t.next(observation({waving:.99}));assert.equal(t.next(observation({waving:.99}),{at:30000}).created,null);
 const created=t.next(observation({waving:.99}),{at:32000}).created;assert.ok(created);t.next(observation({waving:.99}),{at:44000});assert.equal(t.state.pending.length,0);
});
