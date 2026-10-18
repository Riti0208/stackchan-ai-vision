/** Read-only UI served independently of the product FE and local simulator assets. */
export const monitorHTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StackChan 部屋モニター</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10151e;color:#e4ebf5}body{max-width:1200px;margin:auto;padding:28px}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px}p{line-height:1.7;color:#aab9cb}form{display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:24px 0}label{display:grid;gap:6px;font-size:13px}input,button{font:inherit;border:1px solid #41516a;border-radius:7px;padding:10px;background:#182231;color:inherit}button{cursor:pointer;background:#214d74}button:disabled{opacity:.5;cursor:default}#state{color:#80d1bf}#devices{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:18px}.card{background:#182231;border:1px solid #304058;border-radius:12px;padding:20px;min-width:0}.card p{white-space:pre-wrap;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:1fr 1fr;font-size:14px;gap:9px}dt{color:#aab9cb}dd{margin:0;text-align:right}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 4px;border-bottom:1px solid #304058}.scroll{overflow:auto}#events{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;max-height:350px;overflow:auto;background:#182231;padding:16px;border-radius:8px}small{color:#aab9cb}a{color:#80c8ff}
</style><script src="/monitor/app.js" defer></script></head><body>
<h1>StackChan 部屋モニター</h1><p>部屋ごとの接続・通信・感情とAPIの実行状況を観察します。</p>
<form id="login"><label>ルーム<input id="room" value="main" required pattern="[a-z0-9][a-z0-9_-]{0,31}" maxlength="32"></label><label>部屋のトークン<input id="token" type="password" required autocomplete="off"></label><button id="connect">接続</button><button type="button" id="disconnect" disabled>切断</button></form>
<p id="state" role="status" aria-live="polite">未接続</p><p id="health"></p>
<section id="devices" aria-label="デバイス一覧"></section><h2>イベント</h2><small>直近100件。APIの履歴はサーバーに保持された直近120件から表示します。</small><pre id="events"></pre>
</body></html>`;
export const monitorJS = String.raw`
'use strict';
const $ = id => document.getElementById(id);
const sockets = new Map(), cards = new Map(), events = [], seenCalls = new Set(), seenDialogue = new Set();
let running = false, generation = 0, healthTimer, listTimer, currentRoom = '';
function text(tag, value, parent) { const element = document.createElement(tag); element.textContent = String(value); parent.append(element); return element; }
function event(device, message) { events.push(new Date().toLocaleTimeString() + ' ' + device + ' ' + message); if(events.length > 100) events.shift(); $('events').textContent = events.join('\n'); $('events').scrollTop = $('events').scrollHeight; }
function dialogue(message) { if(seenDialogue.has(message.id))return; seenDialogue.add(message.id); if(seenDialogue.size>200)seenDialogue.delete(seenDialogue.values().next().value); event(message.from_device_id,'→ '+message.to_device_id+' 「'+message.text+'」'); }
function num(value, suffix = '') { return value == null ? '—' : String(value) + suffix; }
function pair(parent, label, value) { text('dt', label, parent); text('dd', value, parent); }
function render(id) {
  const card = cards.get(id), data = card.data, root = card.root; root.replaceChildren();
  text('h2', id + ' · ' + (data.device_status?.online ? 'オンライン' : 'オフライン') + (card.connection==='接続済み'?'':'（最終受信時）'), root);
  text('small', 'モニター: ' + card.connection, root);
  const stats = text('dl', '', root), t = data.telemetry;
  pair(stats,'性格',data.memory?.first_join_at===null ? '未参加' : data.mind?.personality || '—'); pair(stats,'意向',data.mind?.intent || '—');
  pair(stats,'受信FPS',num(t?.transport.received_fps)); pair(stats,'受信フレーム',num(t?.transport.frames_received));
  pair(stats,'受信量',t ? (t.transport.bytes_received / 1024).toFixed(1) + ' KiB' : '—');
  pair(stats,'API呼び出し累計',num(t?.api_attempts_total));
  pair(stats,'アップロード p95',num(t?.transport.upload_rtt.p95_ms,' ms'));
  pair(stats,'指令ACK p95',num(t?.transport.action_ack_rtt.p95_ms,' ms'));
  pair(stats,'映像→動作ACK p95',num(t?.transport.frame_to_action_ack.p95_ms,' ms'));
  pair(stats,'処理全体 p95',num(t?.pipeline.p95_ms,' ms'));
  if(t) {
    const wrap = text('div','',root); wrap.className='scroll'; const table=text('table','',wrap), head=text('tr','',table);
    ['API段階','件数','p50 / p95 ms','失敗'].forEach(v=>text('th',v,head));
    for(const [stage,label] of [['perception','観察・感情'],['intention','意向'],['narration','本音・会話']]) { const s=t.stages[stage], row=text('tr','',table); [label,s.count,num(s.p50_ms)+' / '+num(s.p95_ms),s.errors].forEach(v=>text('td',v,row)); }
  }
  text('p','本音: ' + (data.mind?.thought || '—'),root);
  text('p','建前: ' + (data.behavior?.display_text || '—'),root);
  text('small','感情: ' + (data.emotion ? Object.entries(data.emotion).map(([k,v])=>k+' '+Number(v).toFixed(2)).join(' / ') : '—'),root);
}
function send(ws,type,data={}) { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type,timestamp:Date.now(),data})); }
function stop(message='切断しました') { running=false; generation++; clearInterval(healthTimer); clearInterval(listTimer); for(const entry of sockets.values()){clearTimeout(entry.timer); entry.ws.close();} sockets.clear(); for(const [id,card] of cards){card.connection='切断';render(id);} $('connect').disabled=false; $('disconnect').disabled=true; $('state').textContent=message; }
function attach(id, ownGeneration) {
  if(!running || generation!==ownGeneration || sockets.has(id))return;
  if(!cards.has(id)) {const root=text('article','',$('devices'));root.className='card';cards.set(id,{root,data:{},connection:'接続中'});}
  const card=cards.get(id); card.connection='接続中'; render(id);
  const url=new URL('/ws/monitor',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.search=new URLSearchParams({room:currentRoom,device_id:id}).toString();
  const ws=new WebSocket(url), entry={ws,timer:null,lastRequest:0};sockets.set(id,entry);
  ws.onopen=()=>{card.connection='接続済み';render(id);event(id,'モニター接続');};
  ws.onmessage=e=>{
    if(generation!==ownGeneration || typeof e.data!=='string')return;
    const m=JSON.parse(e.data);
    if(m.type==='device_status' && card.data.device_status?.online!==m.data.online) event(id,m.data.online?'本体オンライン':'本体オフライン');
    if(['mind','behavior','emotion','device_status','memory'].includes(m.type))card.data[m.type]=m.data;
    if(m.type==='telemetry' || m.type==='telemetry_snapshot') {
      card.data.telemetry=m.data;
      if(m.type==='telemetry' && Date.now()-entry.lastRequest>=5000){entry.lastRequest=Date.now();send(ws,'telemetry_request');}
      for(const sample of m.data.samples?.api || []) {
        const key=id+':'+sample.run_id+':'+sample.stage+':'+sample.started_at;
        if(!seenCalls.has(key)){seenCalls.add(key);if(seenCalls.size>1000)seenCalls.delete(seenCalls.values().next().value);event(id,'API '+sample.stage+' '+sample.outcome+' '+sample.rtt_ms+' ms · HTTP '+num(sample.status)+' · tokens '+num(sample.input_tokens)+'/'+num(sample.output_tokens));}
      }
    }
    if(m.type==='dialogue')dialogue(m.data);
    if(m.type==='dialogue_history')for(const message of m.data.messages)dialogue(message);
    if(m.type==='error')event(id,'エラー: '+m.data.code);
    render(id);
  };
  ws.onerror=()=>event(id,'接続エラー');
  ws.onclose=e=>{
    if(generation!==ownGeneration)return;
    sockets.delete(id);card.connection='切断 ('+e.code+')';render(id);event(id,card.connection);
    if(e.code===4003){stop('認証の期限が切れました。再接続してください。');return;}
    if(running){sockets.set(id,entry);entry.timer=setTimeout(()=>{sockets.delete(id);attach(id,ownGeneration);},5000);}
  };
}
async function health(){const r=await fetch('/health',{cache:'no-store'});if(!r.ok)throw new Error('ヘルスチェック失敗');const h=await r.json();$('health').textContent='AI: '+h.ai_mode+' / 実APIセッション: '+(h.paid_session.active?'有効':'停止')+' / 使用回数: '+h.paid_session.used_calls+' / '+h.paid_session.max_calls;}
async function discover(ownGeneration){const r=await fetch('/api/rooms/'+encodeURIComponent(currentRoom)+'/devices',{cache:'no-store'});if(!r.ok)throw new Error('部屋が見つかりません');const list=await r.json();if(running&&generation===ownGeneration)for(const device of list.devices)attach(device.device_id,ownGeneration);}
$('login').addEventListener('submit',async e=>{
  e.preventDefault();if(running)return;$('connect').disabled=true;const ownGeneration=++generation; currentRoom=$('room').value;
  try {
    const r=await fetch('/api/control/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:currentRoom,token:$('token').value})});$('token').value='';
    if(!r.ok)throw new Error(r.status===429?'試行回数が多すぎます。少し待ってください。':'ルームまたはトークンを確認してください。');
    cards.clear();$('devices').replaceChildren();events.length=0;seenCalls.clear();seenDialogue.clear();$('events').textContent='';running=true;$('disconnect').disabled=false;$('state').textContent='部屋 '+currentRoom+' を監視中';
    await Promise.all([health(),discover(ownGeneration)]);
    healthTimer=setInterval(()=>health().catch(()=>{$('health').textContent='ヘルスチェックに失敗しました';}),5000);
    listTimer=setInterval(()=>discover(ownGeneration).catch(()=>{$('state').textContent='部屋一覧の取得に失敗しました';}),10000);
  }catch(error){stop(error.message);}
});
$('disconnect').addEventListener('click',()=>stop());
window.addEventListener('pagehide',()=>stop());
`;
