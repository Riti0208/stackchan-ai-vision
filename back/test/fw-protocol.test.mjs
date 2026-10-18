import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Simulator } from '../scripts/fw-simulator.mjs';
import { parseClientMessage, serializeServer } from '../src/protocol.ts';
const sleep = ms => new Promise(r => setTimeout(r, ms));
test('FW simulator ignores malformed/unsafe commands without consuming seq, then accepts a valid typed command', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const events = [], acks = []; const connected = once(server, 'connection');
  const sim = new Simulator({ base: `http://127.0.0.1:${server.address().port}`, token: 'fake-only', notify: event => events.push(event) });
  try {
    sim.start(); const [peer] = await connected;
    peer.on('message', (raw, binary) => { if (!binary) { const result = parseClientMessage(raw.toString(), 'device'); if (result.ok && result.message.type === 'action_ack') acks.push(result.message.data); } });
    peer.send(serializeServer('session', { protocol_version: 2, frame_format: 'rgb565le-v2', width: 160, height: 120, role: 'device', room: 'main', device_id: 'stackchan-01' }));
    peer.send('{');
    const data = { seq: 1, action: 'nod', pan: 0, tilt: 0, expression: 'neutral', duration_ms: 500 };
    peer.send(JSON.stringify({ type: 'action', timestamp: 0, data: { ...data, pan: 500 } }));
    peer.send(serializeServer('action', data)); peer.send(serializeServer('action', data));
    for (let i = 0; i < 50 && !acks.length; i++) await sleep(20);
    assert.deepEqual(acks, [{ seq: 1, accepted: true }]); assert.equal(events.filter(e => e.type === 'action').length, 1);
    assert.equal(events.filter(e => e.type === 'sim_error').length, 2); assert.equal(sim.lastSeq, 1); assert.equal(sim.action.pan, 0);
  } finally { sim.stop(); for (const peer of server.clients) peer.terminate(); await new Promise(resolve => server.close(resolve)); }
});


test('simulator sends no frame before a validated v2 session and rejects v1',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const sim=new Simulator({base:`http://127.0.0.1:${server.address().port}`,token:'fake-only',fps:4});
 const connected=once(server,'connection');let received=0;
 try {
  sim.start();const [peer]=await connected;peer.on('message',(_raw,binary)=>{if(binary)received++;});
  await sleep(100);assert.equal(received,0);assert.equal(sim.connected,false);
  const closed=once(peer,'close');peer.send(JSON.stringify({type:'session',timestamp:0,data:{protocol_version:1,role:'device',room:'main',device_id:'stackchan-01'}}));
  assert.equal((await closed)[0],1008);assert.equal(received,0);
 }finally{sim.stop();for(const peer of server.clients)peer.terminate();await new Promise(resolve=>server.close(resolve));}
});
