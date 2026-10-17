# 通信仕様 v1 — FE / BE / FW

更新日: 2026-10-17。対象: 2026-10-18のハッカソン。

本書は実装用の通信契約。BE・認証・デプロイが実装済みであることを示すものではない。
本番DOMAINと接続用の秘密情報は別途チームへ共有する。

## 1. 設計案からの変更と固定事項

[設計案 v1.0](stackchan_ai_vision_spec_v1.md)のJSONフィールド・動作語彙・画像ヘッダーを引き継ぐ。
以下は設計案の追加・変更であり、通信については本書を優先する。

- **同一roomに複数のスタックチャンが参加可能**。各本体はroom内で一意な`device_id`を持つ。
- WebSocketは`(room, device_id)`単位。閲覧・制御対象を接続URLで指定する。
- 制御ブラウザは**各デバイスにつき1接続**。閲覧ブラウザは複数接続可能。
- `session` / `stream` / `error`イベントと、デバイス一覧・制御ログインAPIを追加する。
- `detection.data.stream_id`と`decision.data.stream_id`を追加し、本体再接続前の結果を区別する。

roomはグループ、device_idは本体の識別子。例: `main`に`stackchan-01`と`stackchan-02`。
両識別子は`^[a-z0-9][a-z0-9_-]{0,31}$`。URLの両パラメーターは必須。
BEが許可した組み合わせのみ接続可能。URLから新しいroomやデバイスを自動作成しない。

同じroomでも、画像・検出・感情・AI判断・動作番号・制御権をデバイス間で共有しない。
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

```json
{"type":"message_type","timestamp":1792300000000,"data":{}}
```

`timestamp`は送信元が付けるUnixミリ秒の整数。FWの時計が未同期でも受信可能とし、
BEの期限・順序判定にはBE受信時刻と内部の受信順を使う。浮動小数値は有限数に限る。
全ての送信側は必須項目を送り、受信側は未知の追加フィールドを無視する。
未知のメッセージtypeも無視する。ただし許可されていない既知typeの送信は拒否する。

| type / 形式 | 送信経路 | 内容 |
|---|---|---|
| Binary | FW → BE → FE | `uint32 BE frame_id` + JPEG |
| `device_status` | FW → BE → FE | 稼働情報。onlineの最終判断はBE |
| `detection` | 制御FE → BE | 対象画像の顔検出 |
| `emotion` | BE → FE | 5項目の仮想感情 |
| `decision` | BE → FE | AI観測・選択行動 |
| `action` | BE → FW | 首・表情の指令 |
| `session` | BE → FE / FW | 接続対象と権限 |
| `stream` | BE → FE | カメラ接続世代 |
| `error` | BE → FE / FW | 通信契約違反等 |
| `heartbeat` | 制御FE → BE → 制御FE | 制御接続の生存確認 |

viewer接続後、BEは`session` → `stream` → 現在の`emotion` → 現在の`device_status`の順に送る。
初期配信後にライブ画像・更新イベントを流す。過去の判断ログや画像履歴は再送しない。
FW接続後は最初に`session`を送る。各接続の対象とroleは接続中に変更しない。

```json
{"type":"session","timestamp":1792300000000,"data":{"protocol_version":1,"room":"main","device_id":"stackchan-01","role":"controller"}}
```

roleは`device | viewer | controller`。制御FEは`controller`受信後に検出結果の送信を開始する。
接続済み本体に別の正規FW接続が来た場合は新接続を優先し、旧接続を4001で閉じる。
旧接続の遅れた切断通知で新接続をofflineにしない。

## 4. 画像・stream・顔検出

画像ヘッダーは設計案どおり。1 WSメッセージに1画像を格納する。

```text
offset 0..3: frame_id (uint32, big-endian)
offset 4.. : JPEG bytes
```

初期目標は320×240・2fps。1fps / 160×120へ縮小してもヘッダーは変えない。
FWはフレームごとにIDを1増やす（uint32循環）。再接続時は0に戻してよい。
BEはデバイスごとに最新画像だけを推論用メモリーに保持し、画像を永続保存しない。
FW・BE・FEはアプリ内の未処理画像を積み上げず最新を優先する。
既に送信したWSメッセージは取り消せないため、配送済み古フレームの到着はあり得る。
BEは遅い閲覧接続を1013で閉じて再接続させ、他の本体や閲覧者を待たせない。

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
| `decision` | `stream_id`: string、`frame_id`: uint32、`observations`: 下記4項目、`selected_action`: Action、`confidence`: number 0〜1 |
| `action` | `seq`: 正整数、`action`: Action、`pan`, `tilt`: number -1〜1、`expression`: Expression、`duration_ms`: 整数100〜3000 |
| `device_status` | `online`: boolean、`fps`: number 0以上、`wifi_rssi`: numberまたはnull、`battery`: number 0〜100またはnull、`current_action`: Action |

- Action = `idle | look_at | nod | shake | happy`。
- Expression = `neutral | happy | sad | surprised | thinking`。
- observations = `person_present`, `smiling`, `looking_at_robot`, `waving`: 各number 0〜1。
- 初期emotionは順に`0.5, 0.5, 0.2, 0.2, 0.5`。本体ごとに独立する。
- `decision`はBEが整形するアプリイベント。外部AI APIの生レスポンスにFE/FWを依存させない。

```json
{"type":"decision","timestamp":1792300000000,"data":{"stream_id":"opaque-stream-id","frame_id":120,"observations":{"person_present":0.98,"smiling":0.91,"looking_at_robot":0.74,"waving":0.12},"selected_action":"happy","confidence":0.87}}
```

```json
{"type":"action","timestamp":1792300000000,"data":{"seq":101,"action":"look_at","pan":-0.5,"tilt":0.2,"expression":"happy","duration_ms":500}}
```

pan/tiltは**正面基準の絶対目標位置**を正規化した値で、相対移動量ではない。
panは負が左・正が右、tiltは負が下・正が上。FWが物理角度へ変換する。
符号は元のカメラ画像で見た追跡方向と実機を合わせて校正する。
BEは顔の中心と現在の指令位置から次の絶対目標を計算する。追跡ゲインは実機で調整する。

seqは各FW接続で1から開始。FWは接続成功時に最終seqをリセットし、古い・重複seqを無視する。
nod/shake/happyはduration_ms内で完了するジェスチャーで、pan/tiltを基準位置とする。
BEはジェスチャー中に次の追跡・ジェスチャー指令を送らない。FWもジェスチャーを優先する。
終了後は新しい検出結果から追跡を再開する。検出が3秒途絶した場合は追跡を止めidleへ移る。
FWは通信断でジェスチャーを止め、安全な待機状態へ移る。可動範囲・速度制限はFWの責任。

FWは接続直後と以後5秒ごとにdevice_statusを送る。未取得値はnull、未計測FPSは0。
BEは接続直後の暫定値として`online: true, fps: 0, wifi_rssi: null, battery: null, current_action: idle`を配信可。
BEが15秒間device_statusを受信しなければ接続を閉じる（4000）。
本体切断時はBEが同じ形式で`online: false, fps: 0, wifi_rssi: null, battery: null, current_action: idle`を通知する。
このidleはオフライン表示用であり、実機の停止完了を確認した値ではない。

AI判断は各本体で約2秒周期、同じ本体では多重実行しない。推論開始時に画像とstreamを固定する。
完了時にstreamが変わった、切断済み、画像受信から10秒超、最後に適用した判断以下の受信順なら破棄する。
推論中に次の画像が届いたことだけを理由に結果を破棄しない。
AI失敗時は感情を維持し、画像・軽量な顔追跡は継続する。全段成功後に感情と判断を反映する。
FEは受信したdecisionを各本体につき直近20件まで保持する。再接続後の履歴復元は対象外。

## 6. エラー・切断・再接続

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
JSONは最大16 KiB、画像はヘッダー込み最大256 KiB。超過は1009。

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

## 7. 担当間の接続チェック

- FW: room/device_idと自機トークンを設定し、session → JPEG送信 → action受信まで確認。
- FE: 一覧取得 → 本体選択 → viewer接続 → stream/JPEG表示まで確認。
- FE/BE: ログイン → control=1 → sessionのrole確認 → stream_id付きdetection送信まで確認。
- BE/FW: frame_idヘッダーとseqの再接続時リセット、pan/tiltの方向を実機で確認。
- 全員: 同じroomに本体2台を接続し、同じframe_idでも画像・感情・動作が混ざらないことを確認。
- 全員: 本体Aの切断・再接続中もBが継続し、Aの古いstreamの検出・AI結果が適用されないことを確認。
- 全員: 本体Aの制御競合、本体Bの独立した制御、一般viewerからの送信拒否を確認。

FPS・推論周期・遅延や複数台時の負荷は未検証。接続台数が増えても各本体の契約は同じとし、
実測に応じてフレーム/推論頻度を下げる。形式・語彙・認証経路を変更するときは本書も更新しチームへ共有する。

## 参考

- [設計案 v1.0（既存JSONの詳細例）](stackchan_ai_vision_spec_v1.md)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [ブラウザのWebSocketコンストラクター](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)
