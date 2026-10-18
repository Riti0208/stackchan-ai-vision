/** Passive monitoring plus explicit authenticated paid-session control, served independently of the product FE and local simulator assets. */
export const monitorHTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StackChan 部屋モニター</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10151e;color:#e4ebf5}body{max-width:1200px;margin:auto;padding:28px}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px}p{line-height:1.7;color:#aab9cb}form{display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:24px 0}label{display:grid;gap:6px;font-size:13px}input,button{font:inherit;border:1px solid #41516a;border-radius:7px;padding:10px;background:#182231;color:inherit}button{cursor:pointer;background:#214d74}button:disabled{opacity:.5;cursor:default}#state{color:#80d1bf}#devices{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:18px}.card{background:#182231;border:1px solid #304058;border-radius:12px;padding:20px;min-width:0}.card p{white-space:pre-wrap;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:1fr 1fr;font-size:14px;gap:9px}dt{color:#aab9cb}dd{margin:0;text-align:right}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 4px;border-bottom:1px solid #304058}.scroll{overflow:auto}#events{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;max-height:350px;overflow:auto;background:#182231;padding:16px;border-radius:8px}small{color:#aab9cb}a{color:#80c8ff}.debug-json{white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto;font-size:12px;background:#10151e;padding:14px;border-radius:8px}#api-detail{margin:20px 0}#api-detail h3{font-size:15px}.head-buttons{display:grid;grid-template-columns:repeat(3,minmax(56px,1fr));gap:6px;max-width:300px}.head-controls{border-top:1px solid #304058;margin-top:18px;padding-top:12px}.head-feedback{min-height:1.7em}#api-detail-status{color:#aab9cb}.api-toolbar{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:14px 0}.api-toolbar label{display:flex;align-items:center}.api-scroll{max-height:430px;overflow:auto;overflow-anchor:none}.api-scroll table{min-width:950px}.api-scroll thead{position:sticky;top:0;background:#182231;z-index:1}.api-scroll td{vertical-align:top}.api-pending{color:#ffd48a}.api-unknown{color:#ffc1ad}.api-scroll button{white-space:nowrap}select{font:inherit;background:#182231;color:inherit;padding:8px;border:1px solid #41516a;border-radius:7px}
</style><script src="/monitor/app.js" defer></script></head><body>
<h1>StackChan 部屋モニター</h1><p>部屋ごとの接続・通信・感情とAPIの実行状況を観察します。</p>
<form id="login"><label>ルーム<input id="room" value="main" required pattern="[a-z0-9](?:[a-z0-9_]|-){0,31}" maxlength="32"></label><label>部屋のトークン<input id="token" type="password" required autocomplete="off"></label><button id="connect">接続</button><button type="button" id="disconnect" disabled>切断</button></form>
<p id="state" role="status" aria-live="polite">未接続</p><p id="health"></p>
<section id="paid-control" hidden><h2>実APIのデバッグ</h2><p>全ルーム・全個体で共通。開始後はカメラ画像をOpenAIへ送信し、利用料が発生します。時間無制限の場合、画面を閉じても停止操作または回数上限まで継続します。終了時は停止してください。</p><div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end"><label>有効時間（秒・0=時間無制限）<input id="paid-seconds" type="number" min="0" max="600" value="0"></label><label>API呼び出し上限<input id="paid-calls" type="number" min="1" max="1000" value="100"></label><button id="paid-start" type="button" disabled>実APIを開始（課金あり）</button><button id="paid-stop" type="button" disabled>実APIを停止</button></div><p id="paid-result" role="status" aria-live="polite"></p></section>
<h2>OpenAI APIの呼び出し</h2><p>直近100件を開始時刻順に表示（新しい呼び出しは下）。30秒以上の待機や切断は完了未確認として表示します。</p><div class="api-toolbar"><label>表示<select id="api-filter"><option value="all">すべて</option><option value="pending">進行中・未確認</option><option value="failed">失敗</option></select></label><label><input id="api-follow" type="checkbox" checked>新着に追従</label><button id="api-clear" type="button">完了履歴をクリア</button></div><p id="api-summary" role="status">受信待ち</p><div id="api-scroll" class="api-scroll"><table><thead><tr><th>開始時刻</th><th>個体 / 段階</th><th>状態 / HTTP</th><th>RTT / 経過</th><th>トークン 入力 / 出力</th><th>request ID</th><th>詳細</th></tr></thead><tbody id="api-calls"></tbody></table></div>
<section id="api-detail" class="card" hidden aria-label="APIリクエストとレスポンスの詳細"><button id="api-detail-close" type="button">詳細を閉じる</button><h2 id="api-detail-title"></h2><p id="api-detail-status" role="status" aria-live="polite"></p><div id="api-detail-body"></div></section>
<section id="devices" aria-label="デバイス一覧"></section><h2>イベント</h2><small>直近100件。本文詳細は直近20件・10分以内、合計1MiBまで。画像は形式とサイズのみ表示します。APIの履歴はサーバーに保持された直近120件から表示します。</small><pre id="events"></pre>
</body></html>`;
export const monitorJS = String.raw`
'use strict';
const $ = id => document.getElementById(id);
const sockets = new Map(), cards = new Map(), events = [], seenCalls = new Set(), seenDialogue = new Set(), apiRows = new Map();
let selectedDebug = null, debugTimer;
const apiNodes = new Map();
let apiClearedAt = 0, apiLastUpdate = null;
let paidBusy = false, lastHealth = null, paidError = '';
let running = false, generation = 0, healthTimer, listTimer, currentRoom = '';
function text(tag, value, parent) { const element = document.createElement(tag); element.textContent = String(value); parent.append(element); return element; }
function event(device, message) { const view=$('events'), follow=view.scrollHeight-view.clientHeight-view.scrollTop<24; events.push(new Date().toLocaleTimeString() + ' ' + device + ' ' + message); if(events.length > 100) events.shift(); $('events').textContent = events.join('\n'); if(follow) view.scrollTop = view.scrollHeight; }
function dialogue(message) { if(seenDialogue.has(message.id))return; seenDialogue.add(message.id); if(seenDialogue.size>200)seenDialogue.delete(seenDialogue.values().next().value); event(message.from_device_id,'→ '+message.to_device_id+' 「'+message.text+'」'); }
function apiKey(item){return item.id+':'+item.run_id+':'+item.stage;}
function apiCall(id,stage,run,state,sample) {
  const key=id+':'+run+':'+stage, previous=apiRows.get(key);
  // A replayed start must never overwrite a confirmed completion.
  if(previous?.state==='completed'&&state==='started')return;
  if(state==='completed'&&!previous&&sample.started_at<=apiClearedAt)return;
  const item={id,stage,run_id:run,...sample,state,updated_at:Date.now(),uncertain:false};
  apiRows.set(key,item);apiLastUpdate=Date.now();
  if(apiRows.size>100){
    const ordered=[...apiRows.entries()].sort((a,b)=>a[1].started_at-b[1].started_at);
    apiRows.delete((ordered.find(([,value])=>value.state==='completed')||ordered[0])[0]);
  }
  if(selectedDebug&&apiKey(selectedDebug)===key&&state==='completed'&&previous?.state==='started')$('api-detail-status').textContent='完了を受信しました。本文を再選択すると最新の詳細を取得します。';
}
function uncertainAPI(id){
  for(const item of apiRows.values())if(item.id===id&&item.state==='started')item.uncertain=true;
  if(selectedDebug?.id===id){clearTimeout(debugTimer);$('api-detail-status').textContent='接続が切れたため本文の更新を確認できません。再接続後に選択してください。';}
  renderAPI();
}
function renderAPI(){
  const root=$('api-calls'), viewport=$('api-scroll'), position=viewport.scrollTop;
  const filter=$('api-filter').value||'all', now=Date.now();
  const anchor=[...root.children].find(row=>row.getBoundingClientRect&&row.getBoundingClientRect().bottom>viewport.getBoundingClientRect().top+40);
  const anchorTop=anchor?.getBoundingClientRect().top;
  const all=[...apiRows.values()].sort((a,b)=>a.started_at-b.started_at);
  const rows=all.filter(item=>filter==='pending'?item.state==='started':filter==='failed'?item.state==='completed'&&item.outcome!=='success':true);
  const visible=new Set(rows.map(apiKey));
  for(const [key,node] of apiNodes)if(!visible.has(key)){node.row.remove();apiNodes.delete(key);}
  for(const item of rows){
    const key=apiKey(item);let node=apiNodes.get(key);
    if(!node){
      const row=text('tr','',root), cells=Array.from({length:6},()=>text('td','',row));
      const button=text('button','JSONを見る',text('td','',row));button.type='button';
      button.addEventListener('click',()=>{const current=apiRows.get(key);if(current)inspectAPI(current);});
      row.dataset.apiKey=key;node={row,cells,button};apiNodes.set(key,node);
    }
    const elapsed=Math.max(0,Math.floor((now-item.started_at)/1000)), pending=item.state==='started';
    const unknown=pending&&(item.uncertain||elapsed>=30);
    const values=[new Date(item.started_at).toLocaleTimeString(),item.id+' / '+item.stage,pending?(unknown?'完了未確認'+(item.uncertain?'（接続切断）':'（30秒以上）'):'呼び出し中'):item.outcome+' / '+num(item.status),pending?elapsed+' 秒経過':num(item.rtt_ms,' ms'),num(item.input_tokens)+' / '+num(item.output_tokens),item.request_id||'—'];
    values.forEach((value,i)=>{if(node.cells[i].textContent!==value)node.cells[i].textContent=value;});
    node.row.className=unknown?'api-unknown':pending?'api-pending':'';
    node.button.disabled=pending||!running||sockets.get(item.id)?.ws.readyState!==WebSocket.OPEN;
  }
  // Move only rows whose order changed; ordinary updates preserve focus and selection.
  rows.forEach((item,index)=>{const row=apiNodes.get(apiKey(item)).row;if(root.children[index]!==row)root.insertBefore(row,root.children[index]||null);});
  const pending=all.filter(item=>item.state==='started'), unknown=pending.filter(item=>item.uncertain||now-item.started_at>=30000).length;
  $('api-summary').textContent='表示 '+rows.length+' / '+all.length+' 件（上限100） · 進行中 '+(pending.length-unknown)+' · 完了未確認 '+unknown+' · 完了 '+(all.length-pending.length)+' · 最終受信 '+(apiLastUpdate===null?'—':new Date(apiLastUpdate).toLocaleTimeString());
  if(!rows.length&&!root.children.length){const row=text('tr','',root);const cell=text('td',all.length?'該当する呼び出しはありません':'API呼び出しの受信待ち',row);cell.colSpan=7;row.dataset.empty='true';}
  for(const row of [...root.children])if(row.dataset.empty&&rows.length)row.remove();
  viewport.scrollTop=$('api-follow').checked?viewport.scrollHeight:position+(anchor?.parentNode===root?anchor.getBoundingClientRect().top-anchorTop:0);
}
$('api-filter').addEventListener('change',renderAPI);
$('api-follow').addEventListener('change',renderAPI);
$('api-scroll').addEventListener('scroll',()=>{const view=$('api-scroll');if(view.scrollHeight-view.clientHeight-view.scrollTop>24)$('api-follow').checked=false;});
$('api-clear').addEventListener('click',()=>{
  apiClearedAt=Date.now();for(const [key,item] of apiRows)if(item.state==='completed')apiRows.delete(key);
  closeDebug();renderAPI();
});
function closeDebug(){clearTimeout(debugTimer);selectedDebug=null;$('api-detail').hidden=true;$('api-detail-body').replaceChildren();$('api-detail-title').textContent='';$('api-detail-status').textContent='';}
function inspectAPI(item){
  const entry=sockets.get(item.id);if(!running||!entry||entry.ws.readyState!==WebSocket.OPEN)return;
  selectedDebug={...item};$('api-detail').hidden=false;$('api-detail-title').textContent=item.id+' / '+item.stage+' · '+new Date(item.started_at).toLocaleTimeString();$('api-detail-body').replaceChildren();
  $('api-detail-status').textContent='本文を取得中 · HTTP '+num(item.status)+' · request ID '+(item.request_id||'—');
  clearTimeout(debugTimer);debugTimer=setTimeout(()=>{$('api-detail-status').textContent='本文を取得できませんでした。接続状態を確認して、もう一度選択してください。';},5000);
  send(entry.ws,'api_debug_request',{run_id:item.run_id,stage:item.stage});
}
function showDebug(id,data){
  if(!selectedDebug||selectedDebug.id!==id||selectedDebug.run_id!==data.run_id||selectedDebug.stage!==data.stage)return;
  clearTimeout(debugTimer);const root=$('api-detail-body');root.replaceChildren();const detail=data.detail;
  if(!detail){$('api-detail-status').textContent='本文詳細は保持期限・容量を超えたか、この呼び出しでは記録されていません。';return;}
  const item=apiRows.get(id+':'+data.run_id+':'+data.stage)||selectedDebug;
  $('api-detail-status').textContent=detail.method+' '+detail.url+' · HTTP '+num(item?.status)+' · RTT '+num(item?.rtt_ms,' ms')+' · request ID '+(item?.request_id||'—');
  function body(label,value){text('h3',label,root);if(!value){text('p','応答本文なし（HTTP応答前の失敗、または本文なし）',root);return;}text('small',value.bytes+' bytes'+(value.truncated?' 以上 / 一部省略':'')+' · 画像省略 '+value.images_omitted+' 件',root);const pre=text('pre',JSON.stringify(value.body,null,2),root);pre.className='debug-json';}
  body('リクエスト JSON',detail.request);body('レスポンス JSON',detail.response);
  if(detail.error){text('h3','エラー詳細',root);const pre=text('pre',JSON.stringify(detail.error,null,2),root);pre.className='debug-json';}
}
$('api-detail-close').addEventListener('click',closeDebug);
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
  pair(stats,'バックエンドJPEG変換 p95',num(t?.transport.conversion.p95_ms,' ms'));
  pair(stats,'ビューア描画ACK p95',num(t?.transport.viewer_ack_rtt.p95_ms,' ms'));
  pair(stats,'JPEG変換 / 配信',t ? num(t.transport.conversion.converted_total)+' / '+num(t.transport.conversion.published_total)+' · drop '+num(t.transport.conversion.dropped_total) : '—');
  pair(stats,'指令ACK p95',num(t?.transport.action_ack_rtt.p95_ms,' ms'));
  pair(stats,'映像→動作ACK p95',num(t?.transport.frame_to_action_ack.p95_ms,' ms'));
  pair(stats,'処理全体 p95',num(t?.pipeline.p95_ms,' ms'));
  if(t) {
    const wrap = text('div','',root); wrap.className='scroll'; const table=text('table','',wrap), head=text('tr','',table);
    ['API段階','件数','p50 / p95 ms','失敗'].forEach(v=>text('th',v,head));
    for(const [stage,label] of [['perception','観察・感情'],['intention','意向'],['narration','本音・会話']]) { const s=t.stages[stage], row=text('tr','',table); [label,s.count,num(s.p50_ms)+' / '+num(s.p95_ms),s.errors].forEach(v=>text('td',v,row)); }
  }
  renderHead(id,card,root);
  text('p','本音: ' + (data.mind?.thought || '—'),root);
  text('p','建前: ' + (data.behavior?.display_text || '—'),root);
  text('small','感情: ' + (data.emotion ? Object.entries(data.emotion).map(([k,v])=>k+' '+Number(v).toFixed(2)).join(' / ') : '—'),root);
}
function headEnabled(card){return running&&card.connection==='接続済み'&&card.data.device_status?.online===true&&!card.headAuthFailed;}
function updateHead(card){
  if(!card.headButtons)return;
  for(const button of card.headButtons)button.disabled=!headEnabled(card)||card.headBusy||Date.now()<(card.headCooldown||0);
  const head=card.head;
  card.headStatus.textContent=head?'最後の操作目標: pan '+head.pan.toFixed(2)+' / tilt '+head.tilt.toFixed(2)+' · 送信済み seq '+head.seq+' · '+(head.manual_until>Date.now()?'手動期限 '+new Date(head.manual_until).toLocaleTimeString()+'（残り '+Math.ceil((head.manual_until-Date.now())/1000)+'秒）':head.manual_until?'手動期限終了':'手動解除'):'この画面からの手動指令なし';
}
function renderHead(id,card,root){
  const section=text('section','',root);section.className='head-controls';section.setAttribute('aria-label',id+' 首の手動操作');text('h3','首の手動操作',section);
  text('small','左右・上下は0.2ずつ。操作後10秒は自動の首制御を抑止します。表示は指令目標で、実位置ではありません。',section);
  const controls=text('div','',section);controls.className='head-buttons';card.headButtons=[];
  for(const [action,label,name,row,column] of [['up','↑','首を上へ',1,2],['left','←','首を左へ',2,1],['center','中央','首を中央へ',2,2],['right','→','首を右へ',2,3],['down','↓','首を下へ',3,2],['resume','自動に戻す','首の自動制御に戻す',4,1]]){
    const button=text('button',label,controls);button.type='button';button.setAttribute('aria-label',id+' '+name);button.setAttribute('data-head-action',action);button.style.gridRow=String(row);button.style.gridColumn=action==='resume'?'1 / 4':String(column);button.addEventListener('click',()=>headCommand(id,action));card.headButtons.push(button);
  }
  card.headStatus=text('p','',section);const feedback=text('p',card.headBusy?'首の指令を送信中…':card.headFeedback||'',section);feedback.className='head-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');updateHead(card);
}
async function headCommand(id,action){
  const card=cards.get(id);if(!card||!headEnabled(card)||card.headBusy||Date.now()<(card.headCooldown||0))return;
  const ownGeneration=generation;card.headBusy=true;card.headFeedback='';card.headCooldown=Date.now()+500;render(id);
  try{
    const response=await fetch('/api/control/head?'+new URLSearchParams({room:currentRoom,device_id:id}),{method:'POST',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
    const result=await response.json().catch(()=>null);
    if(generation!==ownGeneration||cards.get(id)!==card)return;
    if(!response.ok){if(response.status===401)for(const item of cards.values()){item.headAuthFailed=true;updateHead(item);}throw new Error(response.status===401?'認証期限が切れました。再接続してください。':'HTTP '+response.status+' · '+(result?.error?.message||result?.error?.code||'送信失敗'));}
    if(!result?.ok||result.device_id!==id||!Number.isFinite(result.pan)||Math.abs(result.pan)>1||!Number.isFinite(result.tilt)||Math.abs(result.tilt)>1||!Number.isSafeInteger(result.seq)||result.seq<0||!Number.isFinite(result.manual_until)||result.manual_until<0)throw new Error('応答形式を確認できませんでした');
    card.head=result;card.headFeedback=action==='resume'?'自動制御への復帰を送信しました。':'首の指令を送信しました。';event(id,'首 '+action+' · 目標 pan '+result.pan+' / tilt '+result.tilt+' · seq '+result.seq);
  }catch(error){if(generation===ownGeneration&&cards.get(id)===card)card.headFeedback='首の操作に失敗: '+error.message;}
  finally{if(generation===ownGeneration&&cards.get(id)===card){card.headBusy=false;render(id);setTimeout(()=>{if(cards.get(id)===card)updateHead(card);},Math.max(0,card.headCooldown-Date.now()));}}
}
function send(ws,type,data={}) { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type,timestamp:Date.now(),data})); }
function stop(message='切断しました') { closeDebug();running=false;for(const id of sockets.keys())uncertainAPI(id);renderAPI(); generation++; clearInterval(healthTimer); clearInterval(listTimer); for(const entry of sockets.values()){clearTimeout(entry.timer); entry.ws.close();} sockets.clear(); for(const [id,card] of cards){card.connection='切断';render(id);} $('connect').disabled=false; $('disconnect').disabled=true; $('state').textContent=message; $('paid-control').hidden=true; }
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
    if(m.type==='api_debug')showDebug(id,m.data);
    if(m.type==='api_activity')apiCall(id,m.data.stage,m.data.run_id,m.data.state,m.data.state==='started'?{started_at:m.data.started_at}:m.data.sample);
    if(m.type==='device_status' && card.data.device_status?.online!==m.data.online) event(id,m.data.online?'本体オンライン':'本体オフライン');
    if(['mind','behavior','emotion','device_status','memory'].includes(m.type))card.data[m.type]=m.data;
    if(m.type==='telemetry' || m.type==='telemetry_snapshot') {
      card.data.telemetry=m.data;
      if(m.type==='telemetry' && Date.now()-entry.lastRequest>=5000){entry.lastRequest=Date.now();send(ws,'telemetry_request');}
      for(const sample of m.data.samples?.api || []) {
        apiCall(id,sample.stage,sample.run_id,'completed',sample);
        const key=id+':'+sample.run_id+':'+sample.stage+':'+sample.started_at;
        if(!seenCalls.has(key)){seenCalls.add(key);if(seenCalls.size>1000)seenCalls.delete(seenCalls.values().next().value);event(id,'API '+sample.stage+' '+sample.outcome+' '+sample.rtt_ms+' ms · HTTP '+num(sample.status)+' · tokens '+num(sample.input_tokens)+'/'+num(sample.output_tokens));}
      }
    }
    if(m.type==='dialogue')dialogue(m.data);
    if(m.type==='dialogue_history')for(const message of m.data.messages)dialogue(message);
    if(m.type==='error'){event(id,'エラー: '+m.data.code+(m.data.message?' · '+m.data.message:''));if(m.data.code==='debug_rate_limited'&&selectedDebug?.id===id){clearTimeout(debugTimer);$('api-detail-status').textContent='選択が速すぎます。少し待って、もう一度選択してください。';}}
    if(['api_activity','telemetry','telemetry_snapshot'].includes(m.type))renderAPI();
    render(id);
  };
  ws.onerror=()=>event(id,'接続エラー');
  ws.onclose=e=>{
    if(generation!==ownGeneration)return;
    sockets.delete(id);uncertainAPI(id);card.connection='切断 ('+e.code+')';render(id);event(id,card.connection);
    if(e.code===4003){stop('認証の期限が切れました。再接続してください。');return;}
    if(running){sockets.set(id,entry);entry.timer=setTimeout(()=>{sockets.delete(id);attach(id,ownGeneration);},5000);}
  };
}
function showPaid() {
  const h=lastHealth;if(!h)return;
  const control=h.paid_control, budget=h.paid_session, updating=h.deployment?.ready===false;
  $('paid-control').hidden=!running || !control?.enabled || currentRoom!==control.room;
  $('paid-start').disabled=paidBusy || updating || budget.active || !control?.key_configured;
  $('paid-stop').disabled=paidBusy || !budget.active;
  $('paid-seconds').disabled=paidBusy || budget.active; $('paid-calls').disabled=paidBusy || budget.active;
  $('paid-result').textContent=paidError || (updating?'更新を反映中です。完了すると開始ボタンが使えるようになります。停止操作は引き続き使えます。':!control?.key_configured?'OpenAI APIキーが未設定です。':budget.active?'実APIが有効です。'+(budget.expires_at===null?'時間無制限':'残り '+Math.max(0,Math.ceil((budget.expires_at-Date.now())/1000))+' 秒')+' / '+budget.used_calls+' / '+budget.max_calls+' 回':'実APIは停止中です（'+(budget.reason||'停止')+'）。');
}
async function health(){const r=await fetch('/health?'+new URLSearchParams({room:currentRoom}),{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('ヘルスチェック失敗');const h=await r.json();if(lastHealth?.deployment?.ready===false&&h.deployment?.ready===true)paidError='';lastHealth=h;$('health').textContent='AI: '+h.ai_mode+' / 動作: '+(h.behavior_mode==='follow_person'?'人物追従':h.behavior_mode==='autonomous'?'自由判断':'不明')+' / 実APIセッション: '+(h.paid_session.active?'有効':'停止')+' / 使用回数: '+h.paid_session.used_calls+' / '+h.paid_session.max_calls;showPaid();}
async function paidCommand(action) {
  if(paidBusy || !running)return;
  if(action==='start'&&lastHealth?.deployment?.ready===false){showPaid();return;}
  const seconds=Number($('paid-seconds').value), max_calls=Number($('paid-calls').value);
  if(action==='start' && (!Number.isInteger(seconds)||seconds<0||seconds>600||!Number.isInteger(max_calls)||max_calls<1||max_calls>1000)){$('paid-result').textContent='時間は0〜600秒（0=時間無制限）、上限は1〜1000回の整数で指定してください。';return;}
  paidError='';paidBusy=true;showPaid();
  try {
    const r=await fetch('/api/control/paid-session?'+new URLSearchParams({room:currentRoom}),{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='start'?{action,seconds,max_calls}:{action})});
    if(!r.ok){const e=await r.json();if(e.error?.code==='deployment_updating'){if(lastHealth)lastHealth.deployment={...lastHealth.deployment,ready:false};throw new Error('更新を反映中です。完了後にもう一度開始してください。');}throw new Error('切り替えに失敗しました: '+e.error?.code);}
    event(currentRoom,action==='start'?'実APIを開始':'実APIを停止');await health();
  }catch(error){paidError=error.message;$('paid-result').textContent=paidError;}
  finally {paidBusy=false;showPaid();}
}
$('paid-start').addEventListener('click',()=>paidCommand('start'));
$('paid-stop').addEventListener('click',()=>paidCommand('stop'));
setInterval(()=>{if(running){renderAPI();showPaid();for(const card of cards.values())updateHead(card);}},1000);
async function discover(ownGeneration){const r=await fetch('/api/rooms/'+encodeURIComponent(currentRoom)+'/devices',{cache:'no-store'});if(!r.ok)throw new Error('部屋が見つかりません');const list=await r.json();if(running&&generation===ownGeneration)for(const device of list.devices)attach(device.device_id,ownGeneration);}
$('login').addEventListener('submit',async e=>{
  e.preventDefault();if(running)return;$('connect').disabled=true;const ownGeneration=++generation; currentRoom=$('room').value;
  try {
    const r=await fetch('/api/control/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:currentRoom,token:$('token').value})});$('token').value='';
    if(!r.ok)throw new Error(r.status===429?'試行回数が多すぎます。少し待ってください。':'ルームまたはトークンを確認してください。');
    cards.clear();$('devices').replaceChildren();events.length=0;seenCalls.clear();seenDialogue.clear();apiRows.clear();apiNodes.clear();apiClearedAt=0;apiLastUpdate=null;closeDebug();$('api-calls').replaceChildren();$('events').textContent='';running=true;$('disconnect').disabled=false;$('state').textContent='部屋 '+currentRoom+' を監視中';
    await Promise.all([health(),discover(ownGeneration)]);
    healthTimer=setInterval(()=>health().catch(()=>{$('health').textContent='ヘルスチェックに失敗しました'; $('paid-start').disabled=true;}),5000);
    listTimer=setInterval(()=>discover(ownGeneration).catch(()=>{$('state').textContent='部屋一覧の取得に失敗しました';}),10000);
  }catch(error){stop(error.message);}
});
$('disconnect').addEventListener('click',()=>stop());
window.addEventListener('pagehide',()=>stop());
`;
