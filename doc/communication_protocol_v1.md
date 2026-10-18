# 通信仕様 v2 — FE / BE / FW

更新日: 2026-10-18。対象: 2026-10-18のハッカソン。

本書は実装用の通信契約。ローカルBE・FWシミュレーターは[起動手順](../back/README.md)を参照。
公開BE・実機・本番FEとの接続確認は別途行う。
本番DOMAINと接続用の秘密情報は別途チームへ共有する。

## 通信契約の型と共有方法

コード上の入口は [`back/src/protocol.ts`](../back/src/protocol.ts)。device sessionは`protocol_version: 2`が必須。viewer/controller sessionは1を維持する。原要求は[raw camera spec](raw_camera_transport_v2.md)を参照。
FEは`ClientMessage` / `ServerMessage`を型としてimportする。FW実装者はこの文書の値域・送信経路を参照する。

- `ClientData` / `ServerData`: メッセージ種別からdata型への対応。`ClientMessage` / `ServerMessage`はtypeでdataを絞り込めるunion。
- `DeviceMessage` / `DeviceServerMessage`: FWに許可する送信・受信の型。`Motion`には本音を含めない。
- `Mind` / `Emotion` / `Decision` / `Behavior` / `Dialogue`等も同じファイルで公開。従来のBE内モジュールからの型exportは互換のため残す。
- `parseClientMessage(raw, role)`: JSONの構造・値域・送信roleを検証し、成功時だけ型付きメッセージを返す。BEで共通利用する。
- `parseDeviceServerMessage(raw)`: FWシミュレーターが動作指令の角度・表情・時間等を検証する。不正指令はseqを消費せず無視する。
- `serializeClient(message)` / `serializeServer(type, data)`: 型を使った送信。受信時の検証を省略する理由にはしない。

```ts
import type { ClientMessage, ServerMessage } from '../back/src/protocol';

const ack: ClientMessage = {
  type: 'frame_ack', timestamp: Date.now(),
  data: { stream_id: 'current-stream', frame_id: 120 }
};
function show(message: ServerMessage) {
  if (message.type === 'mind') console.log(message.data.thought);
}
```

BEは全送信イベントのdata型をチェックし、シミュレーターはJSのままJSDoc＋`checkJs`のstrictチェックで共有型を参照する。
`npm run typecheck`で両方と通信契約の型テストを実行する。`test/protocol-types.ts`は不正な送信や本音のFW送信をコンパイル時に検出できることを確認する。
型はJSONの実値を保証しない。BEは検証後も認証、接続世代、seq・frame順序、期限、ジェスチャー中の制限を別途確認する。
`parseClientMessage`の`unknown_type`は互換性のためBEで無視する。既知typeの権限違反は従来どおり`forbidden`で切断する。
未知の追加フィールドは受信時に無視する。`heartbeat` / `telemetry_request`の既知のdata項目は空。
本音は本人のFE向け、公開会話はroomのFEと宛先の会話入力向け、動作指令は対象FW向けとする。
ローカル専用の`/monitor`・`/camera`ゲートウェイイベントは公開WS契約に含めない。

## 1. 設計案からの変更と固定事項

[設計書 v1.9](stackchan_ai_vision_spec_v1.md)のJSONフィールド・動作語彙を引き継ぎ、FW入力だけraw v2へ変更する。
以下は設計案の追加・変更であり、通信については本書を優先する。

- **同一roomに複数のスタックチャンが参加可能**。各本体はroom内で一意な`device_id`を持つ。
- WebSocketは`(room, device_id)`単位。閲覧・制御対象を接続URLで指定する。
- 制御ブラウザは**各デバイスにつき1接続**。閲覧ブラウザは複数接続可能。
- `session` / `stream` / `error`イベントと、デバイス一覧・制御ログインAPIを追加する。
- `detection.data.stream_id`と`decision.data.stream_id`を追加し、本体再接続前の結果を区別する。
- `frame_ack`を追加し、遅い閲覧者へ画像を無制限に送らない。
- 本音の`mind`、建前の`behavior`、room会話の`dialogue` / `dialogue_history`を追加する。
- 旧FWのJPEGアップロード互換性は廃止する。viewer/controllerのsession v1とJPEG出力は維持する。

roomはグループ、device_idは本体の識別子。例: `main`に`stackchan-01`と`stackchan-02`。
両識別子は`^[a-z0-9][a-z0-9_-]{0,31}$`。URLの両パラメーターは必須。
BEが許可した組み合わせのみ接続可能。URLから新しいroomやデバイスを自動作成しない。

同じroomでも、画像・検出・感情・AI判断・動作番号・制御権をデバイス間で分離する。
公開会話と外に出た動作のみ個体間で共有し、他個体の本音・感情・親しみは意思決定の入力に含めない。
BE内部の配置方法は自由だが、外部契約はこの分離を保証する。

## 2. 接続先と認証

本番はHTTPS / WSS。FEとBEは同じoriginで配信する。ローカル開発はViteのproxy等で
`/api`と`/ws`をBEへ転送し、ブラウザからは同じoriginとして扱う。

| 接続元 | エンドポイント | 認証・用途 |
|---|---|---|
| FW | `GET /ws/device?room=main&device_id=stackchan-01` | Upgrade時の`Authorization: Bearer <DEVICE_TOKEN>` |
| FE（閲覧） | `GET /ws/viewer?room=main&device_id=stackchan-01` | 一般閲覧。送信による制御は禁止 |
| FE（制御） | `GET /ws/viewer?room=main&device_id=stackchan-01&control=1` | ログインCookie必須。`detection`送信可 |
| FE | `GET /api/rooms/main/devices` | 同一room内の登録済みデバイス一覧 |
| FE | `POST /api/control/session` | roomの制御用トークンをCookieセッションへ交換 |

デバイストークンは`(room, device_id)`に紐付ける。他の本体やroomへ流用不可。
制御トークンはroom単位で、そのroom内の各デバイスの制御接続を取得できる。
OpenAIキー、デバイストークン、制御トークン、セッション署名鍵はBEのsecretで管理する。
FWには自機用トークンのみ設定する。URL・Git・FEのビルド成果物へ秘密情報を埋め込まない。

### 制御ログイン

`POST /api/control/session`に`Content-Type: application/json`で送る。
ユーザーが制御トークンを入力する。FEはトークンをlocalStorage等へ保存しない。

```json
{"room":"main","token":"<CONTROL_TOKEN>"}
```

成功: HTTP 200と次のJSON。`Cache-Control: no-store`。

```json
{"room":"main","authenticated":true,"expires_in":43200}
```

BEは`sc_control_<room>`のCookieを設定する。本番属性は
`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`。
Cookieは改ざん検知可能で、room・有効期限・ランダムなセッションIDを結び付ける。
ローカルHTTP開発時のみSecureを省略可。ブラウザのWS接続はCookieを利用する。
POSTとviewerのUpgradeでは、BEがリクエストのOriginをFEの許可originと照合する。
ログイン試行はBEでレート制限する。FWはCookieを使わずBearer認証する。

ログイン成功だけでは制御権を占有しない。`control=1`の接続成功時に取得する。
同じセッションから同じ本体へ再接続した場合は新接続を優先し、旧接続を4001で閉じる。
別セッションが取得中なら409。閉鎖・タイムアウト・認証期限切れで解放する。
同じブラウザが異なる本体の制御接続をそれぞれ持つことは可能。

### デバイス一覧

成功: HTTP 200。登録済み本体を返す。トークン等は含めない。FEは5秒程度ごとに再取得可。

```json
{"room":"main","devices":[{"device_id":"stackchan-01","online":true},{"device_id":"stackchan-02","online":false}]}
```

FEは本体を選んで接続する。複数本体を同時表示するなら、本体ごとにviewer WSを開く。
どの本体のメッセージかはソケットに紐付ける。単一WSで複数本体のJPEGを混在させない。
一覧のonlineは取得時点の情報で、接続後は`device_status`を使う。

## 3. メッセージと初期配信

WSの1メッセージは、JSONテキスト1個または画像バイナリ1個。JSONはUTF-8。
通常dataはobjectだが、BE→FEのbehaviorに限り未発行状態をnullで示す。

```json
{"type":"message_type","timestamp":1792300000000,"data":{}}
```

`timestamp`は送信元が付けるUnixミリ秒の整数。FWの時計が未同期でも受信可能とし、
BEの期限・順序判定にはBE受信時刻と内部の受信順を使う。浮動小数値は有限数に限る。
全ての送信側は必須項目を送り、受信側は未知の追加フィールドを無視する。
未知のメッセージtypeも無視する。ただし許可されていない既知typeの送信は拒否する。

| type / 形式 | 送信経路 | 内容 |
|---|---|---|
| Binary | FW → BE | SCFW v2 + 160×120 RGB565LE（38416 bytes） |
| Binary | BE → FE | `uint32 BE frame_id` + BE生成JPEG |
| `device_status` | FW → BE → FE | 稼働情報。onlineの最終判断はBE |
| `detection` | 制御FE → BE | 対象画像の顔検出 |
| `emotion` | BE → FE | 5項目の仮想感情 |
| `decision` | BE → FE | AI観測・選択行動 |
| `action` | BE → FW | 首・表情の指令 |
| `session` | BE → FE / FW | 接続対象と権限 |
| `stream` | BE → FE | カメラ接続世代 |
| `error` | BE → FE / FW | 通信契約違反等 |
| `heartbeat` | 制御FE → BE → 制御FE | 制御接続の生存確認 |
| `frame_ack` | FE → BE | 画像受信確認。viewer/controllerともに送信 |
| `human_action` | BE → 対象本体のFE | 2回の画像評価から確認した新しい見た目の変化 |
| `telemetry` | BE → 対象本体のFE | API段階別RTT・呼び出し間隔・映像受信・ACK往復・処理結果の集計 |
| `telemetry_request` | FE → BE | 計測の詳細標本を要求。viewer/controllerのみ、1秒に1回まで |
| `telemetry_snapshot` | BE → 要求したFE | 集計値に詳細標本samplesを追加した一回の応答 |
| `frame_received` | BE → FW | rawの受信確認。変換・認識・描画の完了通知ではない |
| `action_ack` | FW → BE | 指令の受信・受け付け可否。モーター動作完了ではない |
| `mind` | BE → 対象本体のFE | 本音・性格・意向・親しみ |
| `memory` | BE → 対象本体のFE | 初回参加日時・保存日時・体験件数 |
| `behavior` | BE → 対象本体のFE | 実際に発行したactionと建前 |
| `dialogue` | BE → 同じroomの全FE | 公開した言葉。内部で宛先のinboxにも配送 |
| `dialogue_history` | BE → FE | 初期配信用のroom会話履歴（最大20件） |

viewer接続後、BEは`session` → `stream` → 現在の`emotion` → 現在の`device_status`の順に送る。
続いて現在の`mind` → `behavior`（未発行ならnull）→ `dialogue_history` → `memory` → `telemetry`を送る。
初期配信後にライブ画像・更新イベントを流す。過去の判断ログや画像履歴は再送しない。
FW接続後は最初に`session`を送る。各接続の対象とroleは接続中に変更しない。

```json
{"type":"session","timestamp":1792300000000,"data":{"protocol_version":1,"room":"main","device_id":"stackchan-01","role":"controller"}}
```

roleは`device | viewer | controller`。制御FEは`controller`受信後に検出結果の送信を開始する。
接続済み本体に別の正規FW接続が来た場合は新接続を優先し、旧接続を4001で閉じる。
旧接続の遅れた切断通知で新接続をofflineにしない。

## 4. 画像・stream・顔検出

FW → BEは認証済みdevice WSのみ。**160×120 RGB565LE raw v2固定**。1 WSメッセージに1画像を格納する。320×240は初期版で受け付けない。

| Offset | Bytes | 内容 |
|---|---|---|
| 0 | 4 | ASCII `SCFW` |
| 4 | 1 | version = 2 |
| 5 | 1 | pixel format = 1 (RGB565LE) |
| 6 | 2 | width = 160 (uint16 BE) |
| 8 | 2 | height = 120 (uint16 BE) |
| 10 | 4 | frame_id (uint32 BE) |
| 14 | 2 | reserved flags = 0 |
| 16 | 38400 | RGB565 low byte first、行優先、paddingなし |

全長は**38416 bytesちょうど**。不正ヘッダー・短い入力・旧JPEG入力は`invalid_raw_frame` / 1008、超過長は`frame_too_large` / 1009で切断する。未認証はWS接続時に拒否し、変換しない。
FWは次のsessionのversion/format/寸法を検証してから送信する。不一致なら送信せず安全に切断する。JPEG fallbackはない。

```json
{"type":"session","timestamp":0,"data":{"protocol_version":2,"role":"device","room":"main","device_id":"stackchan-01","frame_format":"rgb565le-v2","width":160,"height":120}}
```

BEがRGB565をJPEG quality 75へ変換する。BE → viewerの形式とDecisions入力は従来形式を維持し、rawを渡さない。

```text
offset 0..3: frame_id (uint32, big-endian)
offset 4.. : backend-produced JPEG bytes (160x120)
```

roomごとに変換中1枚、待機は認可済みデバイスごとの最新1枚だけ。待機中の旧画像を置き換え、3000ms超過・旧接続/stream・変換後により新しい入力がある結果は破棄する。
`frame_received`はrawの検証・順序受け付け直後の確認で、変換完了やviewer配送を保証しない。
FWはフレームごとにIDを1増やす（uint32循環）。再接続時は0に戻してよい。
BEはデバイスごとに最新画像だけを推論用メモリーに保持し、画像を永続保存しない。
FW・BE・FEはアプリ内の未処理画像を積み上げず最新を優先する。
既に送信したWSメッセージは取り消せないため、配送済み古フレームの到着はあり得る。
FEは画像を受信・消費（描画待ちの旧画像を破棄する場合も含む）するごとに、同じstream/frame_idで受信確認を返す。
BEは変換・鮮度検査を通過した全JPEGを接続中の通常FEへ中継し、OpenAIの評価間隔では間引かない。rawの最新優先による破棄は別途記録する。未ACKは接続ごとに最大120枚・合計8MiB（4バイトヘッダー込み）、最古の未ACKから2000msまで。次の送信で枚数・バイト数の上限を超える場合、または期限到達時に1013 / slow_viewerで閉じる。他の閲覧者は待たせない。
期限は送信前と500ms周期で検査するため、送信が止まってもおおむね2500ms以内に閉じる。ACK待ちで画像の独自キューや再送は作らず、管理情報だけを保持する。
確認は画像配送のフロー制御用であり、顔検出の完了確認ではない。検出は別途非同期に送る。

```json
{"type":"frame_ack","timestamp":1792300000000,"data":{"stream_id":"opaque-stream-id","frame_id":120}}
```

同じstreamのframe_ackはそのIDまでの受信確認を兼ねる。未知ID・前streamの確認は無視する。

本体接続ごとにBEが一意な`stream_id`を発行する。viewer初期配信と本体の接続・切断時に通知する。

```json
{"type":"stream","timestamp":1792300000000,"data":{"stream_id":"opaque-stream-id"}}
```

本体未接続・切断時は`stream_id: null`。新streamの通知はその画像配信より先に行う。
FEはstream変更時に表示画像・顔枠・未処理検出を破棄する。古い非同期検出結果を送らない。
JPEGヘッダーのIDは**そのソケットの現在のstream内**でのみ有効。全本体で一意ではない。

```json
{"type":"detection","timestamp":1792300000000,"data":{"stream_id":"opaque-stream-id","frame_id":120,"faces":[{"id":0,"x":0.25,"y":0.2,"width":0.3,"height":0.4,"confidence":0.98}],"primary_face_id":0}}
```

- `frame_id`: 0〜4294967295の整数。1フレームあたり最大1回送信、初期目標は最大2回/秒。
- `faces`: 最大10件。idはフレーム内で一意な非負整数。
- x/yは左上座標、width/heightは幅・高さ。全て0〜1、幅・高さは正、`x+width <= 1`、`y+height <= 1`。
- confidenceは0〜1。FEは画像外の矩形をクリップし正規化する。左右反転前の元画像座標を送る。
- `primary_face_id`: 面積最大の顔のid。同面積なら最小id。未検出は`faces: []`かつ`primary_face_id: null`。
- BEは現在のstream内で受信済み、受信から3秒以内、前回適用した検出より新しい画像だけを受け付ける。
  重複・逆順・期限切れ・前streamの結果は無視する。frame_idの数値大小だけで順序を比較しない。
- FEは表示中の画像と同じstream/frame_idの枠だけを描画する。画像切り替え時に古い枠を消す。

## 5. 感情・判断・動作・稼働情報

以下のdata項目は全て必須。型と範囲は設計案を引き継ぐ。

| イベント | dataのフィールド |
|---|---|
| `emotion` | `happiness`, `curiosity`, `excitement`, `shyness`, `trust`: 各number 0〜1 |
| `decision` | `stream_id`: string、`frame_id`: uint32、`observations`: 下記8項目と表情分類、`selected_action`: Action、`confidence`: number 0〜1、`mind_revision`、`intent`、`affect`、`human_action`、`reaction`、`ai`（下記と各節を参照） |
| `action` | `seq`: 1〜4294967295の整数、`action`: Action、`pan`, `tilt`: number -1〜1、`expression`: Expression、`duration_ms`: 整数100〜3000 |
| `device_status` | `online`: boolean、`fps`: number 0〜1000、`wifi_rssi`: number -200〜100またはnull、`battery`: number 0〜100またはnull、`current_action`: Action |

- Action = `idle | look_at | nod | shake | happy`。
- Expression = `neutral | happy | sad | surprised | thinking`。
- observationsは8つのnumber 0〜1: `person_present`, `smiling`, `looking_at_robot`, `waving`, `frowning`, `eyes_wide`, `mouth_open`, `tears_visible`。
  加えて`apparent_expression: {label, confidence}`。labelはsmiling / sad_looking / tense_looking / surprised_looking / neutral / unclear、confidenceは0〜1。
- 初回emotionは性格別の初期値（設計書の表）を使用する。再接続では保存値を復元し、本体ごとに独立する。
- `decision`はBEが整形するアプリイベント。外部AI APIの生レスポンスにFE/FWを依存させない。

```json
{"type":"decision","timestamp":1792300000000,"data":{"stream_id":"opaque-stream-id","frame_id":120,"observations":{"person_present":0.98,"smiling":0.91,"looking_at_robot":0.74,"waving":0.12,"frowning":0.05,"eyes_wide":0.1,"mouth_open":0.05,"tears_visible":0.01,"apparent_expression":{"label":"smiling","confidence":0.9}},"selected_action":"happy","confidence":0.87,"mind_revision":1,"intent":"greet","affect":{"provider":"mock","model":null,"previous_emotion":{"happiness":0.5,"curiosity":0.5,"excitement":0.5,"shyness":0.5,"trust":0.5},"confidence":{"happiness":1,"curiosity":1,"excitement":1,"shyness":1,"trust":1},"history_size":0,"received_message_is_new":false},"human_action":null,"reaction":{"trigger":"initial","intent_reassessed":true,"command_issued":true,"selected_choice":"greet:stackchan-02","event_id":null},"ai":{"provider":"mock","model":null,"requests":0,"input_tokens":0,"output_tokens":0,"latency_ms":0,"request_ids":[],"calls":[]}}}
```

```json
{"type":"action","timestamp":1792300000000,"data":{"seq":101,"action":"look_at","pan":-0.5,"tilt":0.2,"expression":"happy","duration_ms":500}}
```

pan/tiltは**正面基準の絶対目標位置**を正規化した値で、相対移動量ではない。
panは負が左・正が右、tiltは負が下・正が上。FWが物理角度へ変換する。
符号は元のカメラ画像で見た追跡方向と実機を合わせて校正する。
BEは顔の中心と現在の指令位置から次の絶対目標を計算する。追跡ゲインは実機で調整する。

`decision`には`mind_revision`（非負整数）と`intent`（後述）を追加する。
selected_actionはその判断の表現であり、送信完了・実行完了を保証しない。実際の指令発行はbehaviorで確認する。

seqは各FW接続で1から開始。FWは接続成功時に最終seqをリセットし、古い・重複seqを無視する。
nod/shake/happyはduration_ms内で完了するジェスチャーで、pan/tiltを基準位置とする。
BEはジェスチャー中に次の追跡・ジェスチャー指令を送らない。FWもジェスチャーを優先する。
**intent=observeのときだけ**新しい検出結果で追跡する。avert/greet/engage/restでは顔位置で指令を上書きしない。
追跡中に検出が3秒途絶した場合は追跡を止めidleへ移る。
FWは通信断でジェスチャーを止め、安全な待機状態へ移る。可動範囲・速度制限はFWの責任。

FWは接続直後と以後5秒ごとにdevice_statusを送る。未取得値はnull、未計測FPSは0。
BEは接続直後の暫定値として`online: true, fps: 0, wifi_rssi: null, battery: null, current_action: idle`を配信可。
BEが15秒間device_statusを受信しなければ接続を閉じる（4000）。
本体切断時はBEが同じ形式で`online: false, fps: 0, wifi_rssi: null, battery: null, current_action: idle`を通知する。
このidleはオフライン表示用であり、実機の停止完了を確認した値ではない。

AI判断は各本体で約2秒周期、同じ本体では多重実行しない。推論開始時に画像とstreamを固定する。
完了時にstreamが変わった、切断済み、画像受信から10秒超、最後に適用した判断以下の受信順なら破棄する。
推論中に次の画像が届いたことだけを理由に結果を破棄しない。
Decisions失敗時は感情を維持し、画像・軽量な顔追跡は継続する。
Lunaの文章生成のみ失敗した場合はテンプレートへ切り替え、generation.provider=fallbackを付けて感情と判断を反映する。
FEは受信したdecisionを各本体につき直近20件まで保持する。再接続後の履歴復元は対象外。

## 6. 本音・建前・同じroomの会話

BEが全イベントの発行元。FE/FWからこれらを注入することは禁止し、1008で閉じる。
本音は観客向けのロボットの演出的な内面であり、モデルの内部思考過程ではない。
一般viewerも対象本体のmindを閲覧できる。ロボットの意思決定には自分のmindのみ渡す。

### mind: 本音と意向

```json
{"type":"mind","timestamp":1792300000000,"data":{"device_id":"stackchan-02","revision":2,"personality":"shy","intent":"engage","target":{"kind":"device","device_id":"stackchan-01"},"thought":"声をかけてくれて、すごくうれしい。でも照れる……。","generation":{"provider":"openai","model":"gpt-6-luna","reason":null},"relationships":{"stackchan-01":0.6},"cause":{"kind":"dialogue","message_id":"greeting-id"},"valid_until":1792300006000}}
```

| 項目 | 定義 |
|---|---|
| device_id | このWSで閲覧している本体 |
| revision | 非負整数。本体接続ごとに0から開始、意向変更時に増加 |
| personality | curious / shy / cheerful / calm / cautious / playful |
| intent | observe / greet / engage / avert / rest / acknowledge_person / delight |
| target.kind | person / device / none。deviceの場合のみtarget.device_idがstring、それ以外はnull |
| thought | ロボットの内面を示す短文、1〜160文字。通常Luna生成、mock/失敗時は模擬文・テンプレート。人間の感情を断定しない |
| generation | null または下記の生成元オブジェクト。初期・切断時はnull |
| relationships | 相手device_id→親しみ0〜1。未登録の基準は0.5 |
| cause | observation / dialogue / human_action。会話の場合message_idは受信会話id、それ以外はnull。人間イベント関連ではevent_idを追加 |
| valid_until | BE基準のUnixミリ秒。通常6秒の意向維持。新しい人間アクション、受信会話、curious / cheerful / playfulのobserve中の新しい相手への挨拶で割り込める |

emotionは別イベントで配信する。mindをFWや相手ロボットに渡さない。
親しみのみ変わり意向を維持する場合、同じrevisionでmindを再送できる。

generationの形:

```json
{"provider":"openai","model":"gpt-6-luna","reason":null}
```

providerはopenai / mock / fallback。modelはopenaiだけgpt-6-luna、それ以外はnull。
reasonは通常null。fallbackの場合はapi_error（失敗・タイムアウト・不正応答・refusal）、
rate_limit（429）、cooldown（再試行待ち・最低生成間隔内）。本音と、同じ判断から発行する会話文の出所を示す。
同じ意向の文を再利用した場合は元のgenerationを維持する。
FEはfallbackをモデル生成と表示しない。behavior.display_textは常にBEの動作説明であり、生成台詞ではない。

decision.aiはprovider(openai/mock)、model(gpt-6-luna/null)、requests、input_tokens、output_tokens、latency_ms、request_ids、callsを持つ。
requestsと合計値はこの判断中に成功して検証まで完了した呼び出しのみ。失敗したAPIの課金額まで表すものではない。
callsの各項目はendpoint(decisions/responses)、model、request_id(string/null)、input_tokens、output_tokens、latency_ms。
意向・文章の再利用時はresponsesの呼び出しが含まれない。mockはcalls=[]、各合計0。
APIキー・プロンプト・APIの生レスポンスはイベントに含めない。

v1.9のdecisionにはaffectも付く。形は次のとおり。

```json
{"provider":"openai","model":"gpt-6-luna","previous_emotion":{"happiness":0.5,"curiosity":0.5,"excitement":0.2,"shyness":0.8,"trust":0.5},"confidence":{"happiness":0.8,"curiosity":0.9,"excitement":0.8,"shyness":0.7,"trust":0.6},"history_size":3,"received_message_is_new":true}
```

providerはopenai / mock、modelはgpt-6-luna / null。previous_emotionは今回の更新前、confidenceは5感情の各scoreの確信度0〜1。
history_sizeは判断に渡した自分の最近の体験数0〜6。received_message_is_newは受信会話をまだ体験済みにしていない場合true。
感情はDecisionsの5段階score（0〜4の加重平均）を4で割った値。BEの固定加算・減衰を重ねない。
感情全5項目の検証後、対象streamや会話の有効性を再検証して既存emotionイベントで配信する。
顔の見え方とロボット自身の感情は別々に表示する。人物未検出/不確かなら表情を人間の内心として表示しない。


### behavior: 建前と発行した動作

```json
{"type":"behavior","timestamp":1792300000000,"data":{"device_id":"stackchan-02","mind_revision":2,"display_text":"うれしさを隠して、控えめにうなずく","command":{"seq":3,"action":"nod","pan":0,"tilt":0,"expression":"neutral","duration_ms":900},"issued_at":1792300000000}}
```

commandはFWへ発行したaction.dataの同一コピー。display_textは観客向けの建前の説明。
mind_revisionで本音と紐付ける。FWの実行完了を示すACKではない。
本体未接続・切断・新streamで未発行ならdataはnull。FEは前の動作を現在の動作として再表示しない。
意向維持中のdecisionは新しいbehavior/actionを必ずしも伴わない。observe中の追跡は同じmind_revisionで指令を更新できる。

### dialogue: 公開した言葉

```json
{"type":"dialogue","timestamp":1792300000000,"data":{"id":"greeting-id","room":"main","from_device_id":"stackchan-01","to_device_id":"stackchan-02","from_stream_id":"stream-a","to_stream_id":"stream-b","reply_to":null,"speech_act":"greet","text":"お客さんが来たよ。一緒に見てみよう！","created_at":1792300000000,"expires_at":1792300012000}}
```

```json
{"type":"dialogue","timestamp":1792300002000,"data":{"id":"reply-id","room":"main","from_device_id":"stackchan-02","to_device_id":"stackchan-01","from_stream_id":"stream-b","to_stream_id":"stream-a","reply_to":"greeting-id","speech_act":"acknowledge","text":"う、うん。一緒に見よう。","created_at":1792300002000,"expires_at":1792300014000}}
```

全項目必須。idはBEが発行する不透明で一意なstring。実装ではUUID。
reply_toは挨拶ならnull、返答なら元のgreetのid。speech_actはgreet / acknowledge。
created_at/expires_atは整数のUnixミリ秒。expires_atは作成から12秒後。
roomと両本体は同じ登録済みroomに限り、送受信者がオンラインでstream一致の場合だけ配送する。
room全体のFEに同じイベントを送る。FEは複数WS・履歴配信による重複をidで除去する。
他roomのFEには配信しない。dialogueにthought / emotion / relationshipsを含めない。

発言はroomで最低2秒間隔。相手streamごとにgreetは1回。
受信greetに対してacknowledgeを1回返せる。acknowledgeにはlistenという内部choiceで動作のみ応じ、追加発言を作らない。
内部choiceのlisten/replyは外部intentではengageに対応する。音声・TTS・FW上の台詞表示はMVPに含めない。
宛先inboxは最大10件、個体の公開会話履歴は最大10件。
期限切れ、送信元/宛先の切断・新streamで未処理会話を破棄する。

### dialogue_history: 表示用の過去の会話

```json
{"type":"dialogue_history","timestamp":1792300000000,"data":{"messages":[]}}
```

messagesはdialogue.dataの配列、古い順、最大20件。空配列も送る。
期限切れの発言も履歴として表示できるが、inboxへ再投入しない。
遅れて参加したviewerも会話の流れを読める。DO再起動で消える。

### human_actionとdecision.reaction

BEが画像評価の変化から検出する通知。FW/FEから送信できない。

```json
{"type":"human_action","timestamp":1792300000000,"data":{"id":"human-event-id","stream_id":"opaque-stream-id","frame_id":120,"observed_at":1792300000000,"expires_at":1792300010000,"changes":["hand_raised","smile_started"]}}
```

changesはperson_appeared / person_left / hand_raised / smile_started / frown_started /
eyes_widened / mouth_opened / tears_appeared / looked_at_robotの配列。
新しい順序の画像で高値0.8以上2回→開始、低値0.3以下2回→解除。中間値では確定状態を変えず確認回数をリセットする。
人物が0.8以上のときだけ新しい表情/手上げを確定する。人物が0.3以下なら各特徴の解除判定へ進む。
観察間隔が6秒超なら連続確認をやり直す。同じ開始イベントは成立中に繰り返さず、解除→再成立かつ6秒経過で再通知できる。
最大の顔の見た目の比較であり、人物同定や実際の手振り運動の検証は行わない。
FEはidで重複排除し、これを「必ず本体が動作する」という通知として扱わない。

感情・意向が確定したdecisionには、次の追加フィールドを含める。

```json
{"human_action":{"id":"human-event-id","stream_id":"opaque-stream-id","frame_id":120,"observed_at":1792300000000,"expires_at":1792300010000,"changes":["hand_raised"]},"reaction":{"trigger":"human_action","intent_reassessed":true,"command_issued":true,"selected_choice":"acknowledge_person","event_id":"human-event-id"}}
```

human_actionは今回消費したイベント、なければnull。reaction.triggerはhuman_action / dialogue / companion / initial / periodic / held。
intent_reassessedは意向維持を解いて選び直したか、command_issuedは今回新しいFW指令を発行したか。
同じchoiceが続く定期再評価ではcommand_issued=false。selected_choiceは今回選んだchoice。
acknowledge_person / delightのジェスチャーは新しい人間イベントがある場合に限って再発行し、モデルが両者を選び替えても反復しない。
selected_actionは新指令を発行しない場合、直近の実指令のActionを示す。event_idは対象の人間アクションid、なければnull。
mind.causeは人間イベントによる更新ではkind=human_action、message_id=null、event_idを追加する。
会話と同時に処理した場合はkind=dialogueを優先し、event_idは関連する人間イベントのidを保持する。
acknowledge_person / delightはtarget.kind=person、public_text=null。FWのAction/Expression語彙は増やさない。
イベントの有効期限は10秒、未処理最大4件。期限切れ・再接続前のイベントに対する生成結果は破棄する。
確定した観察状態は個体の記憶へ保存するが、未処理イベントや確認途中の回数は再接続へ引き継がない。

actionとの照合は従来どおりbehavior.commandとseqを使う。人間イベントがあっても、回答不正や
動作中・API失敗などで反応がまだ確定していない場合は、human_action通知だけが届くことがある。

### 個体の性格設定

ROOM_CONFIGの各roomには任意のprofilesを追加できる。

```json
{"main":{"control_token":"<room-token>","devices":{"stackchan-01":"<device-01-token>","stackchan-02":"<device-02-token>"},"profiles":{"stackchan-01":"curious","stackchan-02":"shy"}}}
```

profilesは未保存の個体の初回指定。未設定なら認証済みFWの初回接続時に6種類からランダムに選ぶ。
viewer接続・一覧取得だけでは割り当てない。保存済みの性格はprofilesより優先し、再接続でも再抽選しない。
同じroom＋device_idなら性格・感情・直前の本音・親しみ・最近6件の体験と累計件数・
自分に関係する公開会話10件・処理済み会話id100件をDOストレージから引き継ぐ。
部屋変更・device_id変更・保存領域削除は別個体として扱う。管理用の記憶削除APIは追加しない。
同じDO保存領域を使うWorker再起動・再デプロイでも復元する。JPEG、検出、actionは永続化しない。
再接続時の意向はobserve、targetはperson、有効期限は0に戻し、新しい観察から更新する。
前回の本音と生成元は保持するが、古い台詞・動作・未処理メッセージは再送しない。

### memory

初期配信および保存完了時に対象個体のFEへ送る。FWや他個体の判断には送らない。

```json
{"type":"memory","timestamp":1792300000000,"data":{"scope":"room_device","first_join_at":1792299000000,"last_saved_at":1792300000000,"experience_count":4,"total_experiences":12}}
```

first_join_at / last_saved_atはBE基準のUnixミリ秒。FWの初回参加前は両方null。
experience_countは感情判断に渡す直近の体験件数0〜6、total_experiencesは記録した体験の累計。
累計件数は全履歴を保存しているという意味ではない。

### telemetryとペース設定

初期配信、判断処理の完了時、接続中は最長約5秒ごとに対象個体のFEへtelemetryの集計値を送る。
通常配信にはsamplesを含めず、映像の帯域を圧迫しない。詳細標本はtelemetry_request.data={}へのtelemetry_snapshotだけに含める。
要求はviewer/controllerのみ1秒に1回まで。超過時はtelemetry_rate_limitedエラーを返す。
APIの観察・感情(perception)、意向(intention)、本音・会話(narration)を別のstageで記録する。

- samples.api: 直近120試行。stage、endpoint、model、run_id、stream_id、started_at / completed_at、rtt_ms、headers_ms、status、request_id、outcome、input_tokens / output_tokens。
- rtt_ms: BEで呼び出してから、本文の受信・JSON解析・アダプター検証を終えるまで。performance.nowによる経過時間。headers_msは応答ヘッダー受信まで。
- outcome: success / http_error / timeout / network_error / invalid_response / configuration_error。状態反映前に破棄しても実行したAPIは記録する。通信失敗時のstatusやusageはnullになり得る。
- samples.pipelines: 直近60判断。id、stream_id、frame_id、frame_received_at、started_at、completed_at、duration_ms、outcome(committed / discarded / error)、reason。API呼び出しとrun_idで照合する。
- api_attempts_total / pipeline_total: 保存開始以降の累計試行件数。トークンが不明な失敗も含み、請求額の確定値ではない。
- stages: stageごとのcount / p50_ms / p95_ms / max_ms / errors / timeouts、および同じstream内の実際の開始間隔interval。RTT分布には失敗・タイムアウトも含む。
- pipeline: 全判断のp50 / p95、破棄数、失敗数、判断開始時の画像の古さ。duration_msはBEの判断処理全体で、端末での撮影時間は含まない。
- transport: frames_received、bytes_received、直近30秒/最大120枚のreceived_fps・frame_interval、upload_rtt、viewer_ack_rtt、action_ack_rtt、frame_to_action_ack、rejected_actions。
- pacing: stream_fps、evaluation_interval_ms、narration_interval_ms。希望する映像レートと、判断/本音生成の最短開始間隔。

API/判断の履歴はDOのtelemetry:<device_id>へ有界保存し、再起動後も復元する。画像・音声・プロンプト・生成文・APIキー・エラー本文は保存しない。
transportの直近標本とカウンターはstreamごとにリセットする。RTTがまだない場合はnullを返し、0msや取得済みとして扱わない。
履歴から将来の遅延を保証しない。比較時は同じ観察時間、入力源、解像度、viewer数、接続先、個体数を揃える。
collectorもviewerとして受信ACKを返すため、viewer_ack_rttは接続中の全viewerの受信確認を含む。

```json
{"type":"frame_received","timestamp":1792300000000,"data":{"stream_id":"opaque-stream-id","frame_id":120}}
```

FWは同じ接続内のframe_idについて送信時刻と受信確認の時刻から往復時間を計測できる。
FWのdevice_status.dataには任意のtransportを追加できる。

```json
{"transport":{"upload_rtt_ms":12}}
```

upload_rtt_msは0〜60000または未計測のnull。BEはFWの申告値として記録する。
BEからのactionを受信したFWは、対応できる場合に次を返す。seqは現在のFW接続で受信した指令の番号。

```json
{"type":"action_ack","timestamp":1792300000000,"data":{"seq":3,"accepted":true}}
```

BEは送信からACKまでを自分の時計で計測する。accepted=falseなら受信したが実行を受け付けなかった意味。
AIの判断から発行した指令については、BE画像受信→FW受信ACKの時間も記録する。モーター動作完了や撮影→動作の全経路時間ではない。
既存のframe_ackはBE→FE画像受信確認の往復を計測する。現在のLabは描画前にACKを送るため、GPU描画の完了時間は含めない。
古いFWはframe_receivedを無視してよく、action_ack / transport申告がなければ該当RTTは未計測となる。

環境変数で独立して設定する。STREAM_FPS=1〜60（既定60）、EVAL_INTERVAL_MS=500〜10000（既定1000）、
NARRATION_INTERVAL_MS=1000〜30000（既定2000）。未設定・範囲外は既定値を使う。
STREAM_FPSはLabカメラとdemoシミュレーターの目標値。実FWに強制適用しないため、実機はFW側で合わせる。
判断は引き続き単一実行・最新画像のみを使用し、API待ちが長くても古い画像をキューへ積まない。

## 7. エラー・切断・再接続

HTTP APIのエラーは`{"error":{"code":"...","message":"..."}}`。
Upgrade前の拒否も同じHTTP形式を使う。ただしブラウザのWS APIではHTTP本文を取得できないため、
FEは接続失敗を表示し、再ログインや閲覧接続への切り替えをユーザー操作で行えるようにする。

| HTTP | code | 意味 |
|---|---|---|
| 400 | `invalid_request` | 必須引数・形式不正 |
| 401 | `unauthorized` | 未認証・認証期限切れ・トークン不正 |
| 403 | `forbidden` | 対象room/deviceへの権限なし、Origin不許可 |
| 404 | `not_found` | 未登録room/device |
| 409 | `controller_busy` | 他の制御セッションが取得中 |
| 429 | `rate_limited` | 試行・送信頻度の制限 |

接続後の形式不正はerrorを送信し、そのメッセージを破棄する。

```json
{"type":"error","timestamp":1792300000000,"data":{"code":"invalid_message","message":"Invalid detection payload"}}
```

閲覧者からのdetectionやFW以外からのBinaryなど、権限外送信は`forbidden`通知後1008で閉じる。
JSONは最大16 KiB。FW raw入力はヘッダー込み38416 bytesちょうど。超過は1009、不正形式・短い入力は1008。

| close code | 動作 |
|---|---|
| 1000 | 意図した終了。自動再接続しない |
| 1008 / 1009 | 権限・形式・サイズを修正するまで再接続しない |
| 4001 | 新接続による置き換え。古い側は自動再接続しない |
| 4003 | 制御セッション期限切れ。FEは再ログインを要求する |
| 4000 / 1012 / 1013 / その他の予期しない切断 | 1・2・4・8秒、以後最大10秒にランダムな揺らぎを加えて再接続 |

制御権の生存確認に、controllerは5秒ごとに次を送る（一般viewerは不要）。BEは同形式で応答する。

```json
{"type":"heartbeat","timestamp":1792300000000,"data":{}}
```

BEが15秒受信しなければ4000で閉じ、制御権を解放する。認証期限到達時は4003で閉じる。
接続失敗の再試行は最大3回で一度止める。FWは認証設定、FEはログイン/制御権競合を確認できる表示にする。
FEは各WSが閉じた時点でその本体の顔枠を消し、稼働情報を未確認として扱う。
再接続時に画像・検出・actionを再送しない。新session/streamから再開する。

## 8. 担当間の接続チェック

- FW: room/device_idと自機トークンを設定し、session v2検証 → RGB565LE raw送信 → action受信まで確認。
- FE: 一覧取得 → 本体選択 → viewer接続 → stream/JPEG表示まで確認。
- FE/BE: ログイン → control=1 → sessionのrole確認 → stream_id付きdetection送信まで確認。
- BE/FW: frame_idヘッダーとseqの再接続時リセット、pan/tiltの方向を実機で確認。
- 全員: 同じroomに本体2台を接続し、同じframe_idでも画像・感情・動作が混ざらないことを確認。
- 全員: 本体Aの切断・再接続中もBが継続し、Aの古いstreamの検出・AI結果が適用されないことを確認。
- 全員: 本音の喜びとneutral/nodの建前が共存し、相手への会話に本音が含まれないことを確認。
- 全員: greet→acknowledge→非言語反応が成立し、返答のループ・切断後の再配送がないことを確認。
- 全員: 本体Aの制御競合、本体Bの独立した制御、一般viewerからの送信拒否を確認。

FPS・推論周期・遅延や複数台時の負荷は未検証。接続台数が増えても各本体の契約は同じとし、
実測に応じてフレーム/推論頻度を下げる。形式・語彙・認証経路を変更するときは本書も更新しチームへ共有する。

## 参考

- [設計書 v1.9（既存JSONの詳細例）](stackchan_ai_vision_spec_v1.md)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [ブラウザのWebSocketコンストラクター](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)

意向choiceのconfidenceは0〜1の表示値で、採用の固定閾値には使わない。候補外・不正型・範囲外・refusalは拒否する。人間イベントの観察閾値は従来どおり。

## 実APIセッションの開始と上限

通常のローカルdemo/dev/E2Eはモック。キーがあるだけでは実APIを呼ばない。
`npm run demo:openai`を明示実行し、既定60秒または全デバイス・全ルーム合計30リクエストの先着で停止する。
DecisionsとResponsesを送信前の予約で合算し、失敗とタイムアウトも数える。
セッションの期限・予約数は再接続やWorker再起動で更新しない。上限後の自動再開はしない。
`GET /health`は次の`paid_session`を追加する（既存WSメッセージの変更なし）。

```json
{"active":true,"reason":null,"expires_at":1792270800000,"max_calls":30,"used_calls":12}
```

`expires_at`はUnixミリ秒。未開始または時間無制限のセッションではnull（activeで区別する）。`reason`は実行可能時null、それ以外は
`mock` / `not_started` / `expired` / `call_limit`。`used_calls`はセッション全体の予約数であり、
映像や質問数、ドル建て費用ではない。参照は開始・延長・回数リセットをしない。
上限後はBEで送信を拒否し、デモプロセスは自動終了する。時間切れは進行中の通信も中断する。
起動と上限のオプションは[起動手順](../back/README.md)を参照。

## 運用モニター（読み取り専用）

`GET /monitor`と`GET /monitor/app.js`はBEが直接配信する。開くだけでは解析も実APIも開始しない。
部屋トークンを既存の`POST /api/control/session`に渡し、HttpOnly Cookieで認証する。
`GET /ws/monitor?room=<room>&device_id=<id>`は許可Originとその部屋のセッションを必須とする。
`session.data.role`は`viewer`で、制御スロットを占有しない。既存のJSONイベントを購読し、
JPEGは受信しない。通常の統計参照は`telemetry_request`、本文詳細参照は後述の`api_debug_request`を使用する。
`detection`やバイナリ等の書き込みは拒否する。セッション期限切れは4003で切断する。
再接続してもFWや解析の開始は行わない。モニター専用の内部ヘッダーを外部から指定してもBEが上書きする。
`telemetry_snapshot`は既存の直近API120件・パイプライン60件の履歴を返し、累計とは区別する。

## 実APIの明示的な開始・停止（公開デバッグ）

`ENABLE_PAID_CONTROL=true`の環境で、`POST /api/control/paid-session?room=main`を追加する。
`ALLOWED_ORIGIN`と有効な部屋Cookieを必須とし、`PAID_CONTROL_ROOM`（既定main）の認証だけを許可する。
`Content-Type: application/json`、bodyは最大1024 bytes。
- 開始: `{"action":"start","seconds":300,"max_calls":100}`。secondsは整数0〜600（0は時間無制限）、max_callsは整数1〜1000。
- 停止: `{"action":"stop"}`。

応答はpaid_sessionと同じactive/reason/expires_at/max_calls/used_callsにsession_idを加える。
期限・使用量は全ルーム・全個体・全APIで共通。未認証401、Origin/権限不一致403、不正な上限400、
有効なセッションへの二重開始409、APIキー未設定503。開始状態と予算は中央DOのtransactionで保存する。
各送信前にsession_idを照合するため、停止・再開後の古い処理は新しい予算を利用できない。
GET・モニター購読・再接続は開始操作をしない。停止後は新規リクエストを拒否し、進行中の通信を中断する。
期限切れ・上限・手動停止時はモックへ戻り、自動で実APIを再開しない。Workerバージョンの変更でも無効化する。
`/health`のpaid_controlにenabled/key_configured/roomを返し、実効ai_modeは稼働中だけdecisions。
JSONのWebSocketモニター契約は引き続き読み取り専用。開始・停止だけを上記の別HTTP経路で操作する。

映像を2fpsに制限する受信契約ではない。通常FEへの中継とOpenAI評価の間隔は独立。
遅いviewerは4節の未ACK上限（120枚・8MiB・2000ms）で切断してバックログを防ぐ。60fps・JPEG約64KiB以下なら最大約2秒のACK待ちを許容するが、大きい画像では8MiBの上限が先に適用される。

### モニター専用 api_activity

`ServerData.api_activity`は、call_id/run_id/stream_id/device_id/stage/endpoint/modelを共通項目とする。
`state=started`ではstarted_at、`state=completed`ではAPISample型のsampleを返す。
モニター専用接続だけへ送信し、本体や既存のFEには追加イベントを流さない。
受信時に進行中の呼び出しがあればstartedを送る。過去の完了履歴はtelemetry_snapshotで補完する。

`GET /api/rooms/<room>/devices`は診断用runtime（最後に評価したai_mode、paid_control_enabled、
key_configured、実行バージョン）も返す。公開設定と部屋側の設定反映を比較でき、キー自体は返さない。


## Raw v2のメトリクスと協調切り替え

`telemetry.transport.input_format = rgb565le-v2`。`frames_received` / `bytes_received` / `received_fps`は認証・形式・順序検証を通ったraw入力を数える。
`conversion`に`count/p50_ms/p95_ms/max_ms`（最新120件）、`converted_total`、`published_total`、`dropped_total`、`errors`を追加する。
convertedはencode完了数、publishedは鮮度検査を通り内部JPEGへ公開した数、droppedは待機置換・期限・旧世代・変換後のsupersededを含む。変換後破棄はconvertedとdroppedの両方に含まれる。
`timing = encode_and_yield_wall_ms`は**変換＋timer yieldの経過時間**であり、CPU課金時間ではない。公開Workersの時計はI/O時だけ進むため、純CPU処理の前後差分をCPU時間と扱わない。CPU特性はローカルworkerd、公開CPUはCloudflareのCPUプロファイルで確認する。
画像・raw bytes・Bearer token・API入力本文をメトリクスに含めない。

BE公開とv2 FW書き込みは協調する。**BE公開後〜v2 FW書き込みまでは旧FWはofflineになる**。旧JPEGを自動fallbackで動かさない。
公開後はdevice session v2、raw受信、viewer JPEG、Decisions用JPEG data URLを順に確認する。実API開始は既存の明示開始・期限・回数上限・停止ガードを継続する。
rawは38416 bytes/枚で、60fpsなら約18.44Mbps/台（WS/TLS/TCP別）。60fpsは設定目標で、実機のfpsや改善を保証しない。
再現手順・結果・測定の限界は[raw v2検証記録](raw_camera_transport_v2_validation.md)を参照。


### 認証済みモニターのAPI本文詳細

`api_activity` / `telemetry_snapshot` は引き続き本文なしの統計だけを返す。完了行の「JSONを見る」から、同じ部屋・個体の認証済み `/ws/monitor` へ次の読み取り要求を送信する。通常viewer・controller・deviceは本文を取得できない。monitor Cookieの期限とOrigin検証は既存契約と同じ。

```json
{"type":"api_debug_request","timestamp":1792270800000,"data":{"run_id":"run-uuid","stage":"perception"}}
```

`run_id` は英数字・underscore・hyphenの1〜80文字、`stage` は `perception` / `intention` / `narration`。接続先個体のrunとstageを照合するため、別個体のrunを指定しても本文を返さない。接続ごと250ms以内の連打は `debug_rate_limited`。認証・購読・本文参照はAPIの開始・予約・再送・延長をしない。

応答 `api_debug.data` は `device_id` / `run_id` / `stage` / `detail`。`detail=null` は期限・容量超過、再起動、記録対象外などで本文が取得できないことを示す。

`detail` は `method` / `url` / `request` / `response` / `error` を持つ。request/responseは `{body, bytes, truncated, images_omitted}`。modelを確定した実送信JSON、質問・文脈、回答・生成text、HTTPエラーのcode/type/messageを保存する。JSON以外や不正JSONは文字列で表示し、`response=null` は応答本文未取得。HTTP status/request ID/RTTは選択元の既存APISampleと併せて表示する。`error` は `{name,message,phase,guard_reason}`（成功時null）。送信前ガード拒否やランタイム例外も記録し、`AbortError` と期限の `TimeoutError` を区別して表示できる。

画像data URLは `{omitted:"image",mime_type:"image/jpeg",bytes:1136}` 等へ置換し、画像本体は保持・転送しない。Authorization/Cookie等のヘッダーは収集せず、本文に反射された既知のAPIキーや機密フィールド値も伏せる。診断用の置換・省略があるため、画面のJSONはwire bytesそのものではなく実内容のサニタイズ済み表示。bytesは省略前UTF-8本文サイズ、エラー本文が上限で打ち切られた場合は取得済みサイズの下限。

本文は各24KiB、文字列・深さ・項目数にも上限を設け、超過箇所を明示する。Room内の専用メモリーキャッシュで直近20件・合計1MiB・取得可能期間10分に制限し、Durable Object storageやCloudflare console/logには保存しない。再起動・デプロイで本文は失われる。ブラウザは選択した1件だけを本文DOMへ展開し、詳細を閉じる／切断で本文を消す。既存の120件統計履歴と本文の保持件数は異なる。


## 動作モードと手動首操作

Env `BEHAVIOR_MODE=follow_person|autonomous`。今回の公開/ローカルはfollow_person、既存自由判断はautonomousで保持する。health.behavior_mode、session.behavior_mode（追加optional項目）、一覧runtime.behavior_modeで観測できる。モード変更自体はAPIを開始しない。

follow_personは同じperceptionのquestionsに`person_horizontal` choice（left/center/right/unknown）と`person_vertical` choice（upper/center/lower/unknown）を追加する。返却は既存choiceの`choice`/`confidence`。最大の見える顔、顔が明瞭でなければ最大の人物の同じ中心を対象とする。中央40〜60%は保持し、正確な座標/bboxは推定させない。person_present>=0.5、各軸confidence>=0.65でpan±0.08、tilt±0.06の有界stepをperception直後に反映する。
人物有りgateは元画像受信から最大6000msかつsession期限まで。同一stream/新しい評価だけを適用し、停止済み応答は捨てる。follow_personではFE detectionによる首の更新は行わず、Decisions応答だけで方向を決定する。送信画像座標を使い、左→pan負、右→pan正、上→tilt正、下→tilt負。鏡像や人物の身体基準に変換しない。autonomousの既存FE detection制御は維持する。全角度は[-1,1]。公開paid control環境のAPI OFF時は追従待機、ローカルmockだけデモ追従する。既存の明示開始・期限・予算・停止を維持する。

`POST /api/control/head?room=<room>&device_id=<id>`は既存room Cookie認証とexact Origin、Content-Type application/jsonを要求する。本文は1024 bytes以下、`{"action":"left"}`のaction 1項目のみ。left/right/up/down/center/resumeを許可し、他キーや値を拒否する。未知room/deviceは404、未認証401、Origin違反403、不正入力400、超過413、offline409、100ms未満の連続操作429。controller leaseは取得しない。

左右上下はBEの現在の指令targetから0.2ずつ（right=pan+、up=tilt+）、centerは0/0。[-1,1]にclampしlook_at 500msで既存expressionを保持する。FW換算pan±30度/tilt±15度の正規化絶対targetで、実測角度ではない。

```json
{"ok":true,"device_id":"stackchan-01","pan":0.2,"tilt":0,"seq":12,"manual_until":1792300010000}
```

manual_untilまで10秒は全自動のhead command・pan/tilt更新を抑止する。感情/本音/会話更新は継続可。FWの3秒watchdogに対して手動は1秒ごとに同targetのlook_atを再送し、そのたびseqを更新する。resumeは即解除のみで新規seqを発行しない。期限後/resume後は新鮮な追従gateに従い、古い観測だけでは再開しない。再接続で手動stateとseqをリセットする。HTTP応答は受付で、到達/受理は既存action_ackとtelemetryで別途確認する。

実機固有の`RGB565_BIG_ENDIAN_DEVICES`補正適用はtelemetry.transportの`input_byte_order: little|big`と`byte_order_override: boolean`で示す。raw format 1の標準契約はLEのまま。productionの既知01以外は未適用。


### デバッグ用実APIの時間制限（2026-10-18更新）

モニターからの明示開始は時間無制限を既定にする。開始bodyの`seconds:0`は時間無制限で、active時の`expires_at:null`を意味する。1〜600は従来の秒数指定として使える。`max_calls`は従来どおり必須の整数1〜1000で、全ルーム・全デバイス共通の予約回数上限を維持する。時間無制限でも手動停止、回数上限、デプロイ世代変更で失効し、画面を開く/再接続するだけでは開始・延長・回数リセットしない。APIごとのタイムアウトと停止時の中断は維持する。CLIローカルデモの有期限設定は変更しない。


### デプロイ反映中の操作

`/health?room=main`の`deployment`にworker_version / room_version / budget_version / readyを返す。3つのバージョンが一致した場合だけready=true。旧版で予算管理のバージョンheaderが無い場合も未反映とする。更新中は実API開始を503 deployment_updatingとRetry-After:5で拒否し、入力値のinvalid_limitsとは区別する。モニターは開始ボタンを無効にして更新中と表示し、5秒ごとに再確認する。反映後にボタンを有効にするが自動開始はしない。停止操作と読み取りは更新中も維持する。CIの反映確認もバージョン一致を条件とする（最大約10分待機、E2Eや実API開始なし）。これは混在時の誤操作を防ぐ仕組みで、Cloudflareの更新時間を短縮・保証するものではない。ルームの強制リセットや接続切断は行わない。
