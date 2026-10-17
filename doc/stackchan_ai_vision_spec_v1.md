# ｽﾀｯｸﾁｬﾝ AI Vision — 簡易仕様書 v1.0

**対象イベント:** DevDay Community Hackathon 2026（2026-10-18）  
**制作時間:** 14:00–17:30  
**担当:** FW / バックエンド / フロントエンド（計3名）

## 1. 目的・MVP

M5Stack公式ｽﾀｯｸﾁｬﾝのカメラ映像をWebで公開し、顔の位置をBounding Boxで可視化する。OpenAI Decisions APIで観察内容とロボットの次の行動を判断し、仮想感情値をWeb上に表示、首とディスプレイ表情を制御する。

**MVP完成条件**

1. デバイスがCloudflareに接続し、画像を送信できる。
2. Webでライブ画像と顔のBounding Boxを表示できる。
3. Decisions APIで画像の状況を評価できる。
4. 評価結果から感情値が変化し、Webに表示される。
5. AIの行動判断に応じて首・表情が変化する。
6. AI判断履歴が画面に表示される。

## 2. 採用技術・構成

| 領域 | 採用技術 |
|---|---|
| デバイス | M5Stack公式 StackChan（ESP32-S3、GC0308カメラ、サーボ、LCD） |
| FW | Arduino / C++、Wi-Fi、WebSocket |
| バックエンド | Cloudflare Workers + Durable Objects |
| AI | OpenAI Decisions API（利用可能モデル・実際のペイロードは開発時に公式仕様確認） |
| 顔検出 | MediaPipe Face Detector（Webブラウザ） |
| フロント | React + Vite |
| ホスティング | Cloudflare |

```text
StackChan ── WSS: JPEG / status ──▶ Cloudflare Workers + Durable Objects
    ▲                                    │           ▲
    │                                    │           │ detection
    └── WSS: action ◀── AI判断 / 状態管理 ┤           │
                                         ├── JPEG ──▶ Webフロント ── MediaPipe
                                         └── emotion / decision / status ──▶ Webフロント
                                         │
                                         └── OpenAI Decisions API
```

**制御ループを分離:** 顔位置を使った追跡はできるだけ軽く実行。Decisions APIによる意味判断は初期目標2秒ごと。AI遅延で映像配信やサーボの補間処理を止めない。

## 3. 担当分担

| 担当 | 実装すること | 送信 | 受信 |
|---|---|---|---|
| **FW** | 撮影・JPEG変換・WSS・首サーボ・LCD表情 | JPEG Binary、`device_status` | `action` |
| **バックエンド** | 接続中継、画像／状態管理、Decisions API、感情更新、行動指示 | JPEG中継、`emotion`、`decision`、`action`、`device_status`中継 | JPEG、`device_status`、`detection` |
| **フロント** | JPEG表示、MediaPipe顔検出、Bounding Box、感情／判断ログUI | `detection`（制御ブラウザのみ） | JPEG Binary、`emotion`、`decision`、`device_status` |

### 接続先

- デバイス: `wss://<DOMAIN>/ws/device?room=main`
- ブラウザ: `wss://<DOMAIN>/ws/viewer?room=main`
- `room=main` はハッカソン中固定。
- **制御用ブラウザは1つ**とし、他の閲覧者からの`detection`送信は受け付けない。
- デバイスと制御ブラウザを認証する。一般閲覧者は制御不可。APIキーや認証トークンを公開Webページに埋め込まない。

## 4. 共通メッセージ形式

画像以外はWebSocketのUTF-8 JSONテキストメッセージ。共通形式:

```json
{
  "type": "message_type",
  "timestamp": 1792300000000,
  "data": {}
}
```

| フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `type` | string | ○ | メッセージ種別 |
| `timestamp` | integer | ○ | Unix時刻（ミリ秒、UTC基準） |
| `data` | object | ○ | 種別ごとの値 |

### 4.1 カメラ画像（Binary）

**FW → バックエンド → フロント**

```text
[frame_id: 4 bytes, uint32, big-endian][JPEG bytes: 可変長]
```

- 解像度の初期目標: **320 × 240**
- 送信頻度の初期目標: **2fps**（性能不足なら1fps／160×120へ）
- `frame_id`: 送信ごとに1増やし、32bitで循環。
- FWのカメラ取得がRGB565の場合はJPEGに変換してから送信。
- バックエンドは保存せず中継。送信が詰まれば**古いフレームを破棄**。
- ブラウザは4バイトのヘッダを除いてJPEGを表示する。

### 4.2 `detection`：顔検出結果

**フロント（制御ブラウザ） → バックエンド**

```json
{
  "type": "detection",
  "timestamp": 1792300000000,
  "data": {
    "frame_id": 120,
    "faces": [
      { "id": 0, "x": 0.25, "y": 0.2, "width": 0.3, "height": 0.4, "confidence": 0.98 }
    ],
    "primary_face_id": 0
  }
}
```

| 項目 | 型 | 定義 |
|---|---|---|
| `frame_id` | integer | 対象画像ID |
| `faces` | array | 顔の配列。未検出なら`[]` |
| `faces[].id` | integer | **そのフレーム内のみ有効**な識別番号 |
| `faces[].x`, `.y` | number | 顔矩形の左上（0〜1） |
| `faces[].width`, `.height` | number | 顔矩形の幅・高さ（0〜1） |
| `faces[].confidence` | number | 検出信頼度（0〜1） |
| `primary_face_id` | integer / null | 注目顔のID。顔がなければ`null` |

**座標系:** 左上が `(0,0)`、右下が `(1,1)`。中心は `centerX=x+width/2`、`centerY=y+height/2`。注目対象は**面積最大の顔**。フレーム間の顔IDの永続性は保証しない。

### 4.3 `emotion`：ｽﾀｯｸﾁｬﾝの仮想感情値

**バックエンド → フロント**

```json
{
  "type": "emotion",
  "timestamp": 1792300000000,
  "data": {
    "happiness": 0.74,
    "curiosity": 0.82,
    "excitement": 0.48,
    "shyness": 0.25,
    "trust": 0.50
  }
}
```

- 全項目は`number`、**0〜1**。
- 初期値は順に`0.5, 0.5, 0.2, 0.2, 0.5`。
- 更新主体はバックエンド。UIは受信値を0〜100%で表示。
- 人間の真の感情を測定するものではなく、**ロボットの演出的な内部状態**。

### 4.4 `decision`：AI判断ログ

**バックエンド → フロント**

```json
{
  "type": "decision",
  "timestamp": 1792300000000,
  "data": {
    "frame_id": 120,
    "observations": {
      "person_present": 0.98,
      "smiling": 0.91,
      "looking_at_robot": 0.74,
      "waving": 0.12
    },
    "selected_action": "happy",
    "confidence": 0.87
  }
}
```

- `frame_id`: 判断に使った画像のID。
- `observations.*`: 各項目0〜1（推定確率）。
- `selected_action`: `idle | look_at | nod | shake | happy`。
- `confidence`: 選択行動の推定確率（0〜1）。
- **このJSONはアプリ側で整形するイベント形式。Decisions APIの生レスポンス形式ではない。**

### 4.5 `action`：実機への動作指令

**バックエンド → FW**

```json
{
  "type": "action",
  "timestamp": 1792300000000,
  "data": {
    "seq": 101,
    "action": "look_at",
    "pan": -0.5,
    "tilt": 0.2,
    "expression": "happy",
    "duration_ms": 500
  }
}
```

| フィールド | 型 | 有効値・意味 |
|---|---|---|
| `seq` | integer | 単調増加するコマンド番号（接続セッション内） |
| `action` | string | `idle`, `look_at`, `nod`, `shake`, `happy` |
| `pan` | number | -1〜1。**負:左／0:正面／正:右** |
| `tilt` | number | -1〜1。**負:下／0:正面／正:上** |
| `expression` | string | `neutral`, `happy`, `sad`, `surprised`, `thinking` |
| `duration_ms` | integer | 100〜3000。動作時間 |

- `pan` / `tilt` は**物理サーボ角度ではなく正規化値**。FWが実機可動範囲に変換する。
- 古い`seq`と重複`seq`は無視する。
- ジェスチャー（`nod` / `shake` / `happy`）中は顔追跡よりジェスチャーを優先、終了後に追跡再開。
- 通信断時は安全な待機状態にする。機械的な角度・速度制限はFW側で実装。
- **補足:** Web表示の左右と物理的なサーボの回転符号は実機で校正し、上記の**見かけの方向**に合わせる。

### 4.6 `device_status`：稼働状況

**FW → バックエンド → フロント**（目標: 5秒ごと）

```json
{
  "type": "device_status",
  "timestamp": 1792300000000,
  "data": {
    "online": true,
    "fps": 2.0,
    "wifi_rssi": -55,
    "battery": 85,
    "current_action": "look_at"
  }
}
```

| フィールド | 型 | 内容 |
|---|---|---|
| `online` | boolean | デバイス接続状態 |
| `fps` | number | 画像の実送信FPS |
| `wifi_rssi` | number / null | 電波強度（dBm） |
| `battery` | number / null | 残量%（不明なら`null`） |
| `current_action` | string | 現在の動作 |

切断時はバックエンドが`online=false`を通知する。

## 5. Decisions API・状態更新

**担当:** バックエンド

- 推論開始周期の初期目標は**約2秒**。前の処理が未完了なら次を起動しない。
- 最新画像を使う。古いフレームの推論結果で新しい状態を上書きしない。
- 画像に対し`person_present`、`smiling`、`looking_at_robot`、`waving`などを評価（predicate）。
- 結果で`emotion`を更新し、現在状態を条件として次の`action`を評価（choice）。
- 依存する2段階の判断は別リクエストで行う。
- 感情の初期更新例: 笑顔で`happiness +0.1, trust +0.05`、手振りで`excitement +0.1`、人物新規検出で`curiosity +0.1`。判定確率を係数に使い、連続検出による暴走を避けるため減衰・クールダウンを設ける。
- API失敗時は直前の感情値を維持。映像配信と首の補間は続行する。
- Decisions APIが返す内容はそのまま中継せず、**本書の`decision`/`emotion`/`action`形式にバックエンドが変換**する。

## 6. フロントエンド実装要件

1. JPEG Binaryの先頭4バイトから`frame_id`を読む。
2. JPEGをカメラ画面に表示する。
3. MediaPipeで顔を検出し、正規化した`detection`を送る（**認証済み制御ブラウザのみ**）。
4. 同じ画像のBounding Boxを重ねる。表示フレームが変わったら古い枠は消す。
5. `emotion`を5本のメーターに表示する。
6. `decision`の観測確率と行動を履歴表示する（直近20件程度）。
7. `device_status`を接続／FPS表示に利用する。

## 7. FW実装要件

1. 公式スタックちゃんでカメラ・サーボ・LCDの各機能を確認。
2. RGB565取得 → JPEG変換 → `[uint32 BE frame_id][JPEG]`をWSS送信。
3. `action`のJSONを解析し、表情とサーボに反映。
4. `device_status`を約5秒ごとに送信。
5. Wi-Fi／WebSocket切断後の再接続を実装。
6. カメラ負荷が高い場合はJPEG品質 → FPS（1fps） → 解像度（160×120）の順で調整。

## 8. 統合ルール・安全性

- **唯一の状態管理元はバックエンド**。Webの各閲覧者が感情や行動を直接決定しない。
- 顔追跡は軽量・高速、意味判断は低頻度。競合時はFWのジェスチャー優先。
- WSS切断時は再接続。積み残した画像は破棄。
- OpenAI APIキーはサーバーのみで管理。
- 会場の撮影対象には撮影・映像公開について知らせ、同意を得る。顔画像を永続保存しない。
- 公開デモに顔映像やAI判断を流す場合、必要に応じて閲覧アクセスを制限する。

## 9. 開発当日の目安

| 時間 | FW | バックエンド | フロント |
|---|---|---|---|
| 14:00–14:30 | カメラ・サーボ動作確認 | WSS・中継基盤 | UI枠組み |
| 14:30–15:00 | JPEG送信 | Binary中継 | JPEG表示 |
| 15:00–15:30 | `action`受信 | Decisions API | MediaPipe・`detection` |
| 15:30–16:00 | サーボ・表情反映 | 感情状態と行動決定 | Bounding Box・感情UI |
| 16:00–16:30 | 結合 | 結合 | 結合 |
| 16:30–17:00 | 安定化 | エラー対応 | UI調整 |
| 17:00–17:30 | デモ確認 | デモ確認 | デモ確認 |

## 10. 担当間の引き渡しチェック

- **FW → バックエンド:** JPEG Binaryと`device_status`を送れる／受けた`action`で動く。
- **バックエンド → フロント:** 模擬JPEGと`emotion`/`decision`/`device_status`を配信できる。
- **フロント → バックエンド:** JPEG表示とMediaPipeの`detection`送信ができる。
- 統合作業前に**画像ヘッダー、座標正規化、`action`の語彙、感情フィールド名**を変更しない。

## 11. 参考資料

- [M5Stack StackChan](https://docs.m5stack.com/en/StackChan)
- [StackChan Camera（公式）](https://docs.m5stack.com/ja/arduino/stackchan/camera)
- [StackChan Servo（公式）](https://docs.m5stack.com/en/arduino/stackchan/servo)
- [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions)
- [Cloudflare Durable Objects WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [MediaPipe Face Detector for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js)

---

**注記:** 数値（FPS、推論周期など）はハッカソン用の初期目標です。APIの実際の利用可能モデル・リクエスト形式、ハードウェアの対応ライブラリについては実装時に公式資料と実機で検証してください。
