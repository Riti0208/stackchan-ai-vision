# StackChan / AI Vision frontend

PCブラウザを主対象にした、1台のスタックチャンを観察するReact + Viteアプリ。
映像・顔枠・性格・本音・5感情・外向きの動作・直近20件のAI判断を、既存BEから受信して表示する。
画面内の値や文章を生成するモック実装は含まない。BEのmockモード時だけヘッダーにDEMOを表示する。

## ローカルで確認

Node.js 22.12以上。リポジトリ直下で一度だけ:

```sh
npm --prefix back ci
npm --prefix front ci
```

別々のターミナルで:

```sh
npm --prefix back run demo
npm --prefix front run dev
```

http://127.0.0.1:5173 を開く。BEは127.0.0.1:8787、FWは既存の模擬FWを使用する。
`back run demo` はキー設定があってもmockを強制し、外部AIのAPIを呼ばない。
Viteは`/api`・`/ws`・`/health`をBEへ転送し、BEのローカル許可Originに合わせる。
通常画面にトークン入力はなく、誰でもviewerとして閲覧できる。
画像は保存せずcanvasに描画する。ブラウザのカメラ・マイクは使用しない。

### Macカメラでの実写確認（ローカルのみ）

`back run demo`を動かしたまま、通常のMacブラウザで http://127.0.0.1:8787 を開き、
対象本体の「カメラを映像源にする」を押してカメラ利用を許可する。
フロントは http://127.0.0.1:5173/?device_id=stackchan-01 で確認する。

映像はMacカメラ → ローカルブリッジ → 模擬FWの認証済みWS → BE → FEの順で流れる。
フロントが直接カメラを映す方式ではないので、本番と同じJPEG中継・受信ACK・MediaPipe処理を確認できる。
AIの本音・感情はdemoのmockモードのままで、実写を外部AIへ送信しない。
終わったらLabで「合成映像に戻す」を押し、カメラを停止する。

本番用`front/dist`にはカメラ入力・ローカルブリッジ接続を含めない。
公開版は公開originのAPI/WSから実機の映像を受信し、顔検出もその公開originのモデル/WASMを使う。

### 表示対象

`?room=main&device_id=stackchan-01` で指定できる。省略時はmainのオンライン本体を優先して1台を選び、接続中はその本体に固定する。
識別子はヘッダーに表示しない。未登録本体や接続失敗時はエラーと再接続ボタンを表示する。

### 顔枠と首の追跡の区別

MediaPipe Face DetectorをWeb Workerで実行し、表示したJPEGと同じstream/frameの顔枠だけを表示する。
モデル・WASM・フォントは同じoriginから配信する。CDN接続や顔画像のアップロードは行わない。

通常のviewerは`frame_ack`のみを返し、`detection`は送信しない。AIの判断と動作はBEが継続して行う。
顔位置を用いた首追跡には、既存BEの認証Cookieを取得したブラウザで`?control=1`を指定する。
この互換経路では、BEからcontrollerのsessionを受け取った後にのみ`detection`とheartbeatを送る。
認証画面は本フロントの対象外。BEのログインAPIまたはローカルLabを使用する。トークンをURL・ビルド・localStorageへ含めない。
公開閲覧者が認証操作する必要はない。

## Cloudflareへの配信

FE単独で別ドメインへ配信せず、既存Workerから`front/dist`を配信する。
`back/wrangler.jsonc`にASSETSとフロントビルドのフックを設定済み。
既存のWorker名・Durable Object・AIモードを維持する。

```sh
# ローカルビルド + 公開用Workerのdry run。アップロードはしない
npm --prefix back run build
```

本番はBE担当が`ROOM_CONFIG`・`SESSION_SECRET`・`ALLOWED_ORIGIN`を設定する。
`ALLOWED_ORIGIN`には公開するFEの正確なhttps origin（末尾スラッシュなし）を設定する。
実際の公開操作は、利用先アカウントを確認したうえで:

```sh
npm --prefix back run deploy
```

公開後は同一originの`/`が画面、`/api/*`がAPI、`/ws/*`がWebSocket、`/health`が動作モードになる。
本番のモデル呼び出し設定と有料セッションの開始は[バックエンド手順](../back/README.md)に従う。
フロントが外部AI呼び出しを開始・延長する機能はない。

## 最低限の検証

```sh
npm --prefix front run build
npm --prefix front run test:smoke
```

スモークは本番ビルドを、実BEコードの独立したローカルWorker（8793 / inspector 9233）から配信し、
模擬FWで映像・ACK・顔検出の起動・感情・本音・動作・ログ・本体再接続・WS切断復帰をブラウザで確認する。
公開環境や実機を操作せず、外部AIへ接続しない。PCのChromeがあれば利用し、なければPlaywrightのChromiumを使う。
必要なら`cd front && npx playwright install chromium`を一度実行する。
スクリーンショットはGit対象外の`front/test-results/`へ保存する。
スモーク実行中の再ビルドはアセット更新によるWorker再起動を起こすので、ビルドとテストは順番に実行する。

## 実装の境界

- 共有型: `back/src/protocol.ts`。本アプリのJSON検証は`src/protocol.ts`で、使用するフィールドを検証する。
- 画像はuint32 big-endianヘッダーを除去し、受信ACKを即時に返す。描画待ちのフレームは最大1枚。
- stream変更・WS切断時は画像と顔枠・未処理結果を破棄し、古い検出を送信しない。
- 1000/1008/1009/4001/4003は自動再接続しない。それ以外は間隔を広げ、連続失敗3回で停止する。
- 感情と本音はBEが唯一の更新元。behaviorは発行済み指令の表示であり、実機動作完了の証拠ではない。
- 顔検出用モデルは固定版BlazeFace short-rangeをインストール時に取得し、SHA-256を検証する。
  WASMは固定版`@mediapipe/tasks-vision`からコピーし、classic Workerへbundleする。
- デザインはCSS/SVGで実装。完成イメージの写真や数値を画面の代替表示には使用しない。

顔検出の実装は[MediaPipe公式ガイド](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js)、
配信構成は[Cloudflare Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/)を参照。

## 初回ロードの演出とCI

初回表示はSVGのアイリスと回転リングを重ねた全画面オーバーレイを表示する。
WSのsessionと顔検出の準備が完了したら、ぼかしと暗幕を900msでフェードアウトする。
本体がオフラインでもsession受信後は待機画面へ進み、準備が長引く場合も最大約11秒で画面を開放する。
`prefers-reduced-motion`では回転を止め、短いフェードにする。再接続のたびには表示しない。

GitHub Actions `.github/workflows/deploy-back.yml` は、mainへのpushでBE/FEを検証し、
既存Worker `stackchan-ai-vision` へ同時配信する。新しいWorkerやsecretの作成は不要。
公開先: https://stackchan-ai-vision.k-i-wrd-setuna-g.workers.dev/ 。
