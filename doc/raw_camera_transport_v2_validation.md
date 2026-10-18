# Raw camera transport v2 validation

2026-10-18。原要求は [raw spec](raw_camera_transport_v2.md)、外部契約は [通信仕様](communication_protocol_v1.md)。この記録はローカル検証であり、公開・FW書き込み・実API検証を実施したという意味ではない。

## 実装とsource確認

- 認証されたdeviceのみSCFW version 2 / RGB565LE / 160×120 / flags 0 / 38416 bytesを受け付ける。旧JPEG入力、不正ヘッダー、短い入力、余分なbytesは拒否。
- device sessionは2とraw format/寸法を通知し、simulatorは検証前に送信しない。viewer/controller sessionは1、出力は従来の4-byte frame ID＋JPEG。AI入力もJPEG data URLを維持する。
- roomごとに変換中1枚、認可済みデバイスごとに待機中の最新1枚。接続・stream・入力順序・3000msの鮮度を検証し、置換・旧世代・古い変換結果を破棄する。
- jpeg-js 0.4.4のencoder sourceを確認。標準CommonJS版はBuffer.fromを使用し、encode呼び出しごとに表を初期化する。固定sourceからBSDライセンス付きのESM adapterを生成し、Uint8Array出力とencoder/76800-byte RGBA scratch再利用へ変更。decoder・Node API・DOMはWorkerへ含めない。
- upstream encoder SHA256: `00bde8df2517eca556669ab6fc27b414e9ba3fc52a0a71e1e37ec7c5f19c3d34`。`node scripts/vendor-jpeg-encoder.mjs`で再生成可能。原パッケージは [jpeg-js](https://github.com/jpeg-js/jpeg-js)。
- input_format、raw入力bytes/fps、変換時間、変換完了/公開/破棄/error数を記録。時間の履歴は最新120件のみ。画像内容・秘密値は記録しない。

## 検証結果

`back/`で実行：

- `npm run typecheck`: pass（BE、simulator、通信型）。
- `npm run test:unit`: 78 pass（rawの色/寸法/JPEG decode、不正入力、最新キュー、session拒否、既存課金ガード、monitor/fetch回帰を含む）。
- `npm run test:e2e`: 39 pass、77.54秒。raw受信→workerd JPEG変換→viewer、異常系・旧JPEG拒否、burst時の最新保持、再接続世代排除、ACK、mock AIのJPEG data URL、期限/予算/停止を確認。
- `front/`の `npm run test:smoke`: pass。production assetsと実Worker/認証付きsimulator経路を実ブラウザで通し、JPEG表示・ACK・顔検出・offline/新stream復帰を確認。FE本体の編集なし。
- `npm run build`: pass（deploy dry-runのみ）。Worker全体127.76 KiB、gzip 36.65 KiB。デプロイしない。
- 実API呼び出しなし。原要求のmessage.txtをraw specへそのまま保存し、内容一致も確認。

## ローカルworkerd性能

`back/`で `node scripts/benchmark-raw.mjs`。固定依存esbuild/Miniflareで純JS変換だけをbundleし、各scene 1000枚を処理。測定JSONは [benchmark snapshot](raw_camera_transport_v2_benchmark.json)。

| 160×120 scene | raw packet bytes | JPEG packet bytes | warm p50 | warm p95 | 最大 |
|---|---:|---:|---:|---:|---:|
| 単色 | 38416 | 1142 | 0ms | 1ms | 4ms |
| 勾配 | 38416 | 8286 | 1ms | 1ms | 2ms |
| ノイズ | 38416 | 23619 | 2ms | 3ms | 12ms |

時計分解能は1ms。0msは瞬時処理を意味しない。上表はencoder初期化後のローカル経過時間で、公開環境の課金CPUそのものではない。保存snapshotは初期化時間を含めていない。再現スクリプトは今後の計測用にinitial_encode_msも出力する。
Inspectorで100枚ごとに観測したused heap最大15,486,804 bytes、最後の確保heap 26,247,168 bytes。RGBA scratchとencoder表を再利用し、3000枚後も同じ有界状態で動作した。強制GCはworkerd未対応のため使わない。この数値はバッチ間の観測値で、全Room・全socket・受信バッファを含む厳密な最大メモリではない。
検証用encoder bundleは7,949 bytes / gzip 3,763 bytes。本体Workerのサイズは上記dry-run値。

[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)は既定CPU 30秒/呼び出し、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)はisolate memory 128MBを記載している。今回のローカル結果ではencoder単体がこれらに収まらない制約は観測されていない。別serviceへ移行していない。
公開の [performance API](https://developers.cloudflare.com/workers/runtime-apis/performance/) の時計はI/O時だけ進む。telemetryの `encode_and_yield_wall_ms` は変換後のtimer yieldまでを含む経過時間であり、CPU時間と表示しない。公開CPUはCloudflareのプロファイル/計測で別途確認する。

## 帯域と協調rollout

rawは38,416 bytes/枚、60fpsなら18.44Mbps/台、2台なら36.88Mbps（WS/TLS/TCP/Wi-Fi overhead別）。上記の同寸法JPEGより約1.63〜33.64倍大きい。これは今回のscene/quality 75との比較で、実FWの旧JPEGとの直接比較ではない。
CoreS3でJPEG化をしなくなる一方、アップロードは大幅に増えうる。60fps達成・実機の総合改善は未検証。公開BE/実FWではinput bytes/fps、upload RTT、変換時間、破棄数、viewer ACK RTTとCloudflare CPUを比較し、raw modeが改善するか判断する。

BE公開とv2 FW書き込みを協調する。**BE公開後〜v2 FW書き込みまでは旧FWはofflineとなる。旧JPEG fallbackはない。** session v2 → raw reception → viewer JPEGを先に確認し、実API確認は既存の明示開始・期限・予算・停止を維持した別工程にする。
