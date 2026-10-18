import { snapshot, newHistory, newTransport } from '../src/telemetry.ts';
import WebSocket from 'ws';
import {writeFile} from 'node:fs/promises';
const option = name => {const i=process.argv.indexOf(`--${name}`);return i>=0?process.argv[i+1]:undefined;};
const base=option('base')||'http://127.0.0.1:8787', origin=option('origin')||new URL(base).origin, room=option('room')||'main';
const seconds=Number(option('seconds')||30);if(!Number.isFinite(seconds)||seconds<5||seconds>600)throw new Error('--seconds must be 5..600');
const ids=(option('devices')||'stackchan-01,stackchan-02').split(','), latest=new Map(), snapshots=new Set(), sockets=[];
const started_at=new Date().toISOString(), startedMs=Date.now();
try {
 for(const id of ids){const url=new URL('/ws/viewer',base);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.search=new URLSearchParams({room,device_id:id}).toString();
  const ws=new WebSocket(url,{headers:{Origin:origin}});sockets.push(ws);let stream;
  ws.on('message',(raw,binary)=>{if(binary){if(stream&&ws.readyState===1)ws.send(JSON.stringify({type:'frame_ack',timestamp:Date.now(),data:{stream_id:stream,frame_id:raw.readUInt32BE()}}));return;}const m=JSON.parse(raw);if(m.type==='stream')stream=m.data.stream_id;if(m.type==='telemetry')latest.set(id,m.data);if(m.type==='telemetry_snapshot'){latest.set(id,m.data);snapshots.add(id);}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(new Error('Could not connect the metrics viewer; check base URL, room, devices and Origin.')));});
 }
 await new Promise(resolve=>setTimeout(resolve,seconds*1000));
 for(const ws of sockets)if(ws.readyState===1)ws.send(JSON.stringify({type:'telemetry_request',timestamp:Date.now(),data:{}}));
 const until=Date.now()+3000;while(snapshots.size<ids.length&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
 for(const id of ids)if(!snapshots.has(id))throw new Error(`No telemetry received for ${id}`);
 const report={started_at,completed_at:new Date().toISOString(),room,seconds,devices:ids.map(device_id=>{const data=latest.get(device_id),h=newHistory();h.api=data.samples.api.filter(a=>a.started_at>=startedMs);h.pipelines=data.samples.pipelines.filter(p=>p.started_at>=startedMs);const window=snapshot(h,newTransport(data.stream_id),data.pacing);return {device_id,...data,observation_window:{started_at,api_attempts:h.api.length,pipeline_attempts:h.pipelines.length,stages:window.stages,pipeline:window.pipeline},transport_window:'current stream; last 120 RTT samples; FPS over latest 30s'};})};
 if(option('output'))await writeFile(option('output'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({seconds,devices:report.devices.map(d=>({device_id:d.device_id,pacing:d.pacing,stages:d.observation_window.stages,pipeline:d.observation_window.pipeline,transport:d.transport,api_attempts_total:d.api_attempts_total}))},null,2));
} finally {for(const ws of sockets)ws.close(1000);}
