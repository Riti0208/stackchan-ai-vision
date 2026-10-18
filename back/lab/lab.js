const $ = (s, parent = document) => parent.querySelector(s);
const devices = new Map();
let captureFPS = 60;
const dialogueSeen = new Set();
const personalityLabels = { curious: '好奇心旺盛', shy: '照れ屋', cheerful: '陽気', calm: 'おっとり', cautious: '慎重', playful: 'いたずら好き' };
const humanChangeLabels = { person_appeared: '人が現れた', person_left: '人が見えなくなった', hand_raised: '手を上げた', smile_started: '笑顔になった', frown_started: '眉をひそめた', eyes_widened: '目を見開いた', mouth_opened: '口を開いた', tears_appeared: '涙が見えた', looked_at_robot: 'こちらを向いた' };
const intentLabels = { acknowledge_person: '人にうなずいて応えたい', delight: 'うれしさを表したい', observe: 'よく見たい', greet: '話しかけたい', engage: '相手に応えたい', avert: '少し目をそらしたい', rest: 'ゆっくりしたい' };
const expressionLabels = { smiling: '笑顔', sad_looking: '悲しげな表情', tense_looking: '険しい表情', surprised_looking: '驚いたような表情', neutral: '穏やかな表情', unclear: '判別困難' };
function receiveDialogue(event) {
  if (dialogueSeen.has(event.id)) return;
  dialogueSeen.add(event.id); while (dialogueSeen.size > 100) dialogueSeen.delete(dialogueSeen.values().next().value);
  $('.empty', $('#dialogue'))?.remove();
  const row = document.createElement('div'); row.className = `utterance${event.reply_to ? ' reply' : ''}`;
  const who = document.createElement('small'); who.textContent = `${event.from_device_id} → ${event.to_device_id}${event.reply_to ? ' · 返答' : ''}`;
  const words = document.createElement('p'); words.textContent = event.text; row.append(who, words); $('#dialogue').append(row);
  while ($('#dialogue').children.length > 20) $('#dialogue').firstChild.remove();
  $('#dialogue').scrollTop = $('#dialogue').scrollHeight;
  log(event.from_device_id, 'dialogue', event.text);
}
 let authenticated = false;
const socketURL = path => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
const message = (type, data) => JSON.stringify({ type, timestamp: Date.now(), data });
const labels = { happiness: 'Happiness', curiosity: 'Curiosity', excitement: 'Excitement', shyness: 'Shyness', trust: 'Trust' };
function log(id, type, detail) {
  $('.empty', $('#events'))?.remove();
  const row = document.createElement('div'); row.className = 'event';
  for (const [tag, text] of [['time', new Date().toLocaleTimeString('ja-JP')], ['code', id], ['strong', type], ['span', detail]]) { const element = document.createElement(tag); element.textContent = text; row.append(element); }
  $('#events').prepend(row); while ($('#events').children.length > 60) $('#events').lastChild.remove();
}
function createDevice(id) {
  const root = $('#device-template').content.firstElementChild.cloneNode(true); $('.device-id', root).textContent = id; root.dataset.device = id;
  $('.source-label', root).textContent = `JPEG / target ${captureFPS} FPS`;
  const source = document.createElement('small'); source.className = 'text-source'; source.textContent = '本音の生成待ち'; $('.inner', root).append(source);
  for (const [key, label] of Object.entries(labels)) { const row = document.createElement('div'); row.className = 'emotion'; row.innerHTML = `<span>${label}</span><div class="track"><div class="fill"></div></div><output>0%</output>`; row.dataset.emotion = key; $('.emotions', root).append(row); }
  const perception = document.createElement('p'); perception.className = 'observation-text'; perception.textContent = 'カメラの表情: 観察待ち'; $('.telemetry', root).after(perception);
  const affect = document.createElement('small'); affect.className = 'affect-text'; affect.textContent = '感情更新の判断待ち'; $('.emotions', root).append(affect);
  const memory = document.createElement('small'); memory.className = 'memory-text'; memory.textContent = '初回参加待ち'; $('.inner', root).append(memory);
  const event = document.createElement('p'); event.className = 'human-event-text'; event.textContent = '人の新しいアクション: 変化待ち'; $('.observation-text', root).after(event);
  const metrics = document.createElement('section'); metrics.className = 'timing-panel';
  const title = document.createElement('strong'); title.textContent = '通信・APIの計測';
  const summary = document.createElement('div'); summary.className = 'timing-summary'; summary.textContent = '計測待ち';
  const save = document.createElement('button'); save.textContent = '計測JSONを保存'; save.className = 'save-telemetry';
  save.onclick = () => { if (d.ws?.readyState !== 1) return; d.pendingDownload = true; save.disabled = true; d.ws.send(message('telemetry_request', {})); };
  metrics.append(title, summary, save); root.append(metrics);
  $('#devices').append(root);
  const d = { id, root, stream: null, count: 0, generation: 0, role: 'viewer', attempts: 0, target: { x: .35, y: .2, width: .3, height: .4 }, source: 'synthetic' };
  devices.set(id, d);
  $('.camera', root).onclick = event => { const rect = event.target.getBoundingClientRect(); d.target = { x: Math.max(0, Math.min(.7, (event.clientX - rect.left) / rect.width - .15)), y: Math.max(0, Math.min(.6, (event.clientY - rect.top) / rect.height - .2)), width: .3, height: .4 }; $('#detection').value = 'manual'; };
  $('.camera-start', root).onclick = () => startCamera(d);
  $('.camera-stop', root).onclick = () => stopCamera(d);
  connect(d, false); return d;
}
function connect(d, control, retry = false) {
  clearTimeout(d.retry); clearInterval(d.heartbeat);
  if (d.ws) { d.ws.intentional = true; d.ws.close(1000); }
  const ws = d.ws = new WebSocket(socketURL(`/ws/viewer?room=main&device_id=${encodeURIComponent(d.id)}${control ? '&control=1' : ''}`)); ws.binaryType = 'arraybuffer';
  d.generation++; d.stream = null; d.role = 'viewer'; $('.role', d.root).textContent = control ? '制御接続中…' : 'viewer';
  ws.onmessage = event => {
    if (d.ws !== ws) return;
    if (typeof event.data !== 'string') { receiveFrame(d, ws, event.data); return; }
    const m = JSON.parse(event.data), a = m.data;
    if (m.type === 'session') {
      d.role = a.role; d.attempts = 0; $('.role', d.root).textContent = a.role;
      if (a.role === 'controller') d.heartbeat = setInterval(() => { if (ws.readyState === 1) ws.send(message('heartbeat', {})); }, 5000);
      log(d.id, 'session', a.role);
    } else if (m.type === 'stream') {
      d.stream = a.stream_id; d.generation++; $('.decision-text', d.root).textContent = '判断待ち'; $('.observation-text', d.root).textContent = 'カメラの表情: 観察待ち'; $('.affect-text', d.root).textContent = '感情更新の判断待ち'; $('.human-event-text', d.root).textContent = '人の新しいアクション: 変化待ち'; $('.camera', d.root).getContext('2d').clearRect(0, 0, 320, 240); $('.frame', d.root).textContent = '—';
      log(d.id, 'stream', a.stream_id || 'offline');
    } else if (m.type === 'device_status') {
      $('.connection', d.root).textContent = a.online ? '● ONLINE' : 'OFFLINE'; $('.connection', d.root).classList.toggle('online', a.online); $('.fps', d.root).textContent = `${a.fps.toFixed(1)} fps`;
    } else if (m.type === 'emotion') {
      for (const key of Object.keys(labels)) { const row = $(`[data-emotion="${key}"]`, d.root); $('.fill', row).style.width = `${a[key] * 100}%`; $('output', row).textContent = `${Math.round(a[key] * 100)}%`; }
    } else if (m.type === 'mind') {
      d.mind = a; $('.thought', d.root).textContent = a.thought;
      const g = a.generation;
      $('.text-source', d.root).textContent = !g ? '本音の生成待ち' : g.provider === 'openai' ? '本音・会話文: OpenAI / gpt-6-luna' : g.provider === 'mock' ? '本音・会話文: MOCK（外部APIなし）' : `本音・会話文: テンプレートへ切替 (${g.reason})`;
      $('.text-source', d.root).classList.toggle('fallback', g?.provider === 'fallback');
      if (g && d.lastTextRevision !== a.revision) { log(d.id, 'narration', `${g.provider}${g.reason ? ` / ${g.reason}` : ''}`); d.lastTextRevision = a.revision; }
      $('.personality', d.root).textContent = personalityLabels[a.personality] || a.personality;
      $('.intent', d.root).textContent = `意向: ${intentLabels[a.intent] || a.intent}${a.target.device_id ? ` → ${a.target.device_id}` : ''}`;
    } else if (m.type === 'telemetry_snapshot') {
      if (d.pendingDownload) { d.pendingDownload = false; const blob = new Blob([JSON.stringify({device_id:d.id,...a},null,2)], {type:'application/json'}); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${d.id}-telemetry.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(link.href),1000); $('.save-telemetry',d.root).disabled = false; }
    } else if (m.type === 'telemetry') {
      d.telemetry = a;
      const value = n => n === null || n === undefined ? '—' : `${n} ms`;
      const panel = $('.timing-summary', d.root); panel.replaceChildren();
      const row = (label, text) => { const p = document.createElement('p'); const name = document.createElement('span'); name.textContent = label; const detail = document.createElement('span'); detail.textContent = text; p.append(name,detail); panel.append(p); };
      row('映像受信 / 目標', `${a.transport.received_fps} / ${a.pacing.stream_fps} fps`);
      row('判断 / 文章生成の最短間隔', `${a.pacing.evaluation_interval_ms} / ${a.pacing.narration_interval_ms} ms`);
      for (const [stage,label] of [['perception','観察・感情'],['intention','意向'],['narration','本音・会話']]) { const s = a.stages[stage]; row(`${label} RTT p50 / p95`, `${value(s.p50_ms)} / ${value(s.p95_ms)} · ${s.count}件 / 失敗${s.errors}`); row(`${label} 実際の開始間隔 p50`,value(s.interval.p50_ms)); }
      row('BEの判断処理 p50 / p95', `${value(a.pipeline.p50_ms)} / ${value(a.pipeline.p95_ms)}`);
      row('映像アップロード往復 p95', value(a.transport.upload_rtt.p95_ms));
      row('FE画像ACK往復 p95', value(a.transport.viewer_ack_rtt.p95_ms));
      row('FW指令ACK往復 p95', value(a.transport.action_ack_rtt.p95_ms));
      row('BE画像受信→FW受信ACK p95', value(a.transport.frame_to_action_ack.p95_ms));
      row('破棄 / 処理失敗（直近）', `${a.pipeline.discarded} / ${a.pipeline.errors}`);
      $('.save-telemetry',d.root).disabled = !!d.pendingDownload;
    } else if (m.type === 'human_action') {
      $('.human-event-text', d.root).textContent = `新しい変化: ${a.changes.map(c => humanChangeLabels[c] || c).join(' / ')} · 意向の再評価待ち`;
      log(d.id, 'human_action', a.changes.map(c => humanChangeLabels[c] || c).join(' / '));
    } else if (m.type === 'memory') {
      $('.memory-text', d.root).textContent = a.first_join_at === null ? '初回参加待ち' : `保存された体験 ${a.total_experiences}件 · 最近${a.experience_count}件を感情判断に参照`;
    } else if (m.type === 'behavior') {
      $('.public-text', d.root).textContent = a?.display_text || '接続後の反応を待っています';
      $('.outward', d.root).classList.toggle('stale', !a);
    } else if (m.type === 'dialogue') receiveDialogue(a);
    else if (m.type === 'dialogue_history') { for (const event of a.messages) receiveDialogue(event); }
    else if (m.type === 'decision') {
      if (a.human_action) $('.human-event-text', d.root).textContent = `変化に反応: ${a.human_action.changes.map(c => humanChangeLabels[c] || c).join(' / ')} → ${intentLabels[a.intent] || a.intent}`;
      else if (a.reaction && !a.reaction.command_issued) $('.human-event-text', d.root).textContent = '新しい反応なし · 同じ動作の繰り返しを抑制';
      const o = a.observations, display = o.apparent_expression;
      const cues = [['smiling', '笑顔'], ['frowning', '眉をひそめる'], ['eyes_wide', '目を見開く'], ['mouth_open', '口を開く'], ['tears_visible', '涙']].filter(([key]) => o[key] >= .5).map(([key, label]) => `${label} ${Math.round(o[key] * 100)}%`);
      $('.observation-text', d.root).textContent = `カメラの表情: ${o.person_present < .5 ? '人物未検出' : !display || display.confidence < .65 ? '判別困難' : `${expressionLabels[display.label]} (${Math.round(display.confidence * 100)}%)`}${cues.length ? ` · 見える手がかり: ${cues.join(' / ')}` : ''}`;
      if (a.affect) $('.affect-text', d.root).textContent = `感情更新: ${a.affect.provider === 'openai' ? 'Decisions / gpt-6-luna' : 'MOCK'} · 参考にした自分の体験 ${a.affect.history_size}件${a.affect.received_message_is_new ? ' · 新しい会話を受信' : ''}`;
      $('.decision-text', d.root).textContent = `#${a.frame_id} → ${intentLabels[a.intent] || a.intent || a.selected_action} · confidence ${Math.round(a.confidence * 100)}% · ${a.ai?.provider === 'openai' ? `OpenAI ${a.ai.model} · input ${a.ai.input_tokens} / output ${a.ai.output_tokens} tokens · ${a.ai.latency_ms} ms` : 'MOCK'}`;
      log(d.id, 'decision', `frame ${a.frame_id} → ${a.selected_action}`);
    } else if (m.type === 'error') { if (d.pendingDownload) { d.pendingDownload = false; $('.save-telemetry',d.root).disabled = false; } log(d.id, 'error', a.message); $('#notice').textContent = a.message; }
  };
  ws.onclose = event => {
    if (d.ws !== ws || ws.intentional) return;
    clearInterval(d.heartbeat); d.stream = null; d.generation++; $('.connection', d.root).textContent = '通信切断'; $('.connection', d.root).classList.remove('online');
    $('.camera', d.root).getContext('2d').clearRect(0, 0, 320, 240); d.role = 'viewer'; $('.role', d.root).textContent = 'disconnected';
    log(d.id, 'close', `${event.code}`);
    if ([1000, 1008, 1009, 4001, 4003].includes(event.code) || d.attempts >= 3) { $('#notice').textContent = `接続を終了しました (${event.code})。トークン・制御権を確認して再接続してください。`; return; }
    const delay = Math.min(10000, 1000 * 2 ** d.attempts++) + Math.random() * 300;
    d.retry = setTimeout(() => connect(d, control, true), delay);
  };
  if (!retry) d.attempts = 0;
}
async function receiveFrame(d, ws, raw) {
  if (raw.byteLength < 8 || !d.stream) return;
  const id = new DataView(raw).getUint32(0, false), stream = d.stream, generation = d.generation;
  ws.send(message('frame_ack', { stream_id: stream, frame_id: id }));
  d.count++; $('.frames', d.root).textContent = d.count;
  if (d.decoding) return;
  d.decoding = true;
  try {
    const bitmap = await createImageBitmap(new Blob([raw.slice(4)], { type: 'image/jpeg' }));
    if (generation !== d.generation || d.ws !== ws) { bitmap.close(); return; }
    const canvas = $('.camera', d.root), context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0, 320, 240); bitmap.close(); $('.frame', d.root).textContent = id;
    const mode = $('#detection').value;
    const face = mode === 'none' ? null : mode === 'manual' ? d.target : { x: .5 + .2 * Math.sin(id / 8) - .15, y: .36 + .06 * Math.cos(id / 10) - .2, width: .3, height: .4 };
    if (face) { context.strokeStyle = '#dcff98'; context.lineWidth = 1.5; context.strokeRect(face.x * 320, face.y * 240, face.width * 320, face.height * 240); }
    if (d.role === 'controller' && ws.readyState === 1) ws.send(message('detection', { stream_id: stream, frame_id: id, faces: face ? [{ id: 0, ...face, confidence: 1 }] : [], primary_face_id: face ? 0 : null }));
  } catch (error) { log(d.id, 'decode_error', error.message); }
  finally { d.decoding = false; }
}
function updateAction(d, a) {
  $('.action-name', d.root).textContent = a.action; $('.angles', d.root).textContent = `PAN ${a.pan.toFixed(2)} · TILT ${a.tilt.toFixed(2)}`; $('.seq', d.root).textContent = `SEQ ${a.seq ?? '—'} · ${a.duration_ms ?? 0} ms`;
  $('.expression', d.root).textContent = a.expression; $('.mouth', d.root).textContent = a.expression === 'happy' ? '◡' : a.expression === 'surprised' ? 'o' : '⌣';
  $('.robot', d.root).style.transform = `perspective(250px) rotateY(${a.pan * 35}deg) rotateX(${-a.tilt * 25}deg)`;
  if (['happy', 'nod', 'shake'].includes(a.action)) $('.robot', d.root).animate(a.action === 'shake' ? [{ rotate: '-10deg' }, { rotate: '10deg' }, { rotate: '0deg' }] : [{ translate: '0 0' }, { translate: '0 7px' }, { translate: '0 0' }], { duration: a.duration_ms });
}
$('#control').onclick = async () => {
  const button = $('#control'); button.disabled = true; $('#notice').textContent = '';
  try {
    const res = await fetch('/api/control/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'main', token: $('#token').value }) });
    if (!res.ok) throw new Error(`ログイン失敗 (${res.status})`);
    $('#token').value = ''; authenticated = true; $('#release').disabled = false;
    for (const d of devices.values()) connect(d, true);
  } catch (error) { $('#notice').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#release').onclick = () => { authenticated = false; $('#release').disabled = true; for (const d of devices.values()) connect(d, false); };
let monitor;
function connectMonitor(attempt = 0) {
  monitor = new WebSocket('ws://127.0.0.1:8790/monitor');
  monitor.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.type === 'demo_restarted') { $('#restart-demo').disabled = false; return; }
    if (m.type === 'sim_snapshot') { for (const snapshot of m.data) { const d = devices.get(snapshot.device_id); if (d) updateAction(d, snapshot.action); } return; }
    const d = devices.get(m.device_id); if (!d) return;
    if (m.type === 'action') { updateAction(d, m.data); log(d.id, 'action → FW', `${m.data.action} / ${m.data.expression} / seq ${m.data.seq}`); }
    else if (m.type === 'sim_frame') { d.source = m.data.source; $('.source-label', d.root).textContent = `${m.data.source.toUpperCase()} / JPEG`; }
    else if (m.type === 'sim_disconnected') { updateAction(d, { action: 'idle', pan: 0, tilt: 0, expression: 'neutral' }); log(d.id, m.type, `code ${m.data.code}`); }
    else log(d.id, m.type, m.data?.message || 'connected');
  };
  monitor.onclose = () => { if (attempt < 3) setTimeout(() => connectMonitor(attempt + 1), 1000 * 2 ** attempt); else $('#notice').textContent = 'FWモニターに接続できません。npm run demo で起動してください。'; };
}
$('#restart-demo').onclick = () => {
  if (monitor?.readyState !== 1) { $('#notice').textContent = 'FWシミュレーターに接続できません。npm run demo で起動してください。'; return; }
  $('#restart-demo').disabled = true;
  $('#dialogue').replaceChildren(); dialogueSeen.clear();
  monitor.send(JSON.stringify({ type: 'restart_demo' }));
  log('main', 'restart', '2台を新streamで再接続');
};
async function startCamera(d) {
  try {
    d.media = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
    const video = document.createElement('video'); video.srcObject = d.media; video.muted = true; video.playsInline = true; await video.play();
    const ws = d.cameraWS = new WebSocket(`ws://127.0.0.1:8790/camera?device_id=${encodeURIComponent(d.id)}`);
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    ws.onopen = () => {
      $('#detection').value = 'manual'; $('.camera-start', d.root).hidden = true; $('.camera-stop', d.root).hidden = false;
      d.cameraTimer = setInterval(() => { if (ws.readyState !== 1 || ws.bufferedAmount > 256 * 1024) return; canvas.getContext('2d').drawImage(video, 0, 0, 320, 240); canvas.toBlob(blob => { if (blob && ws.readyState === 1) ws.send(blob); }, 'image/jpeg', .7); }, 1000 / captureFPS);
    };
    ws.onerror = () => { $('#notice').textContent = 'ローカルカメラブリッジに接続できません。'; stopCamera(d); };
    ws.onclose = () => stopCamera(d);
  } catch (error) { $('#notice').textContent = `カメラ: ${error.message}`; stopCamera(d); }
}
function stopCamera(d) {
  clearInterval(d.cameraTimer); d.media?.getTracks().forEach(t => t.stop()); d.media = null;
  const ws = d.cameraWS; d.cameraWS = null; if (ws && ws.readyState < 2) { ws.onclose = null; ws.close(1000); }
  $('.camera-start', d.root).hidden = false; $('.camera-stop', d.root).hidden = true;
}
try {
  const health = await (await fetch('/health')).json(); captureFPS = health.pacing?.stream_fps || 2; $('#ai-mode').textContent = health.ai_mode === 'mock' ? 'AI: MOCK · 外部API呼び出しなし' : `AI: Decisions + Luna${health.ai_configured ? '' : ' · APIキー未設定'}`;
  $('#mode-description').textContent = health.ai_mode === 'mock' ? '観察・文章生成はモック。性格と状態に応じた会話の流れを確認できます。' : '観察・感情・意向はDecisions、本音と会話文はLuna Responsesで生成。カメラ映像はOpenAIへ送信されます。';
  const res = await fetch('/api/rooms/main/devices'); if (!res.ok) throw new Error('デバイス一覧を取得できません。.dev.vars を確認してください。');
  const list = await res.json(); for (const device of list.devices) createDevice(device.device_id);
  connectMonitor();
} catch (error) { $('#notice').textContent = error.message; }
window.addEventListener('beforeunload', () => { for (const d of devices.values()) { stopCamera(d); d.ws?.close(1000); } monitor?.close(1000); });
