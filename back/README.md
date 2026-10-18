# StackChan backend / local E2E lab

Cloudflare Workers + Durable Objectsで動くBEと、同じ通信契約を使うFW相当クライアント。
`front/`と`fw/`の実装を待たずに、JPEG中継・検出入力・感情更新・action受信をローカルで確認する。

## 起動

Node.js 22.6以上（22.18以降を推奨）。共有契約のTypeScriptをNodeの型除去で読み込むため、npmスクリプトは`--experimental-strip-types`を指定する。初回は依存パッケージの取得にネット接続が必要。以後mockモードの実行に
OpenAI・Cloudflareのアカウントや外部モデル/CDNは不要。

```sh
cd back
npm ci
npm run demo
```

[http://127.0.0.1:8787](http://127.0.0.1:8787)を開く。
初回だけ`.dev.vars.example`を`.dev.vars`へコピーし、次をまとめて起動する。

- Workers / Durable Objectsローカル実行: 127.0.0.1:8787
- FWシミュレーター2台: 同じmain room、stackchan-01 / stackchan-02、320×240 / 2fps
- ローカルのFW受信モニターとカメラブリッジ: 127.0.0.1:8790

「制御トークン」に`.dev.vars`内のmainのcontrol_tokenを入力する。
サンプル設定では`dev-control-main`。「制御を開始」を押すと、両本体のcontroller接続を取得する。
Ctrl+Cで全プロセスを止める。8787 / 8790は他のプロセスで使用しないこと。

### 画面で確認すること

1. 色の異なる2台のJPEG画像とFRAME番号が更新される。
2. 制御開始後、roleがcontrollerになり、模擬detectionがBEへ届く。
3. 初回参加で性格を抽選し、本音・意向・建前が個体ごとに表示される。保存済みなら同じ性格と体験で再開する。
4. roomの会話欄で「笑顔を見つけたよ。一緒に見てみない？」→「う、うん。声をかけてくれて、ありがとう。」などを確認する。
5. FWが受信したaction・seq・pan/tilt・expressionがカードとタイムラインに表示される。
6. 約2秒周期でdecision・emotionが更新される。
7. 「映像をクリックして注目位置を指定」に変え、本体ごとに別の顔位置を入力して追跡方向を確認する。
   追跡は意向がobserveのときのみ有効。avertの間は検出位置で首の向きを上書きしない。
8. 「顔なし」を選び、顔追跡が停止することを確認する。モック観察は別の入力であるため、意向はモックの人物ありシナリオに従う。
9. 別タブで閲覧する。別の制御セッションが競合した場合は409で拒否される。
   同じCookieセッションの接続は新しいタブを優先し、古い接続を4001で終了する。

**AI_MODE=mockは画像認識をしない。** frame_idに応じた決まった観察結果を生成する。
観察・感情更新・意向は模擬アダプターから同じBE処理へ通す。合成顔は笑顔・驚き・眉をひそめる・涙・手上げ・解除の6場面を繰り返す。
mockは固定の観察値から新しいアクションを検出する。実APIでは描画顔を人間と判定しない場合、人間イベントは出ない。
本音と台詞は観察・性格・選択結果に応じた決定的な模擬出力。Luna生成とは表示しない。画面側の固定タイマーによる会話ではない。
返答まで約2〜4秒。意向は通常6秒保持するが、新しい人間アクションでは再評価する。本音を見ながら建前・実指令の違いを観察できる。
同じ相手streamへの挨拶は1回。ラボをリロードしても会話は再開せず、room履歴を再表示する。
「2台を再接続」でローカルシミュレーター2台を新streamとして再接続できる。
このボタンは127.0.0.1の開発用ゲートウェイだけを操作し、公開BEのリセットAPIは追加しない。
顔の矩形も合成映像に合わせた模擬入力であり、実際のMediaPipe検出ではない。
実写への笑顔判定の精度や実機の可動方向を検証したことにはならない。

### PCカメラを映像源にする

各本体の「カメラを映像源にする」を押し、ブラウザのカメラ利用を許可する。
映像はブラウザ → ローカルNodeブリッジ → FW認証付きWS → ローカルBE → viewerの順に流れる。
音声は取得しない。ブラウザ内のJPEG化は320×240 / 2fps。Node側が4バイトヘッダーを付与する。
カメラトークンをFEに渡さず、FWのBearer認証経路をそのまま使う。
「合成映像に戻す」でカメラを停止する。ブラウザを閉じてもカメラを停止する。

実写時は手動注目位置へ切り替える。実顔検出は本番FE側のMediaPipeで置き換える。
カメラ権限・接続は実際に利用するブラウザで確認すること。

### 独立したFWクライアント

BE単独は`npm run dev`で起動する（`.dev.vars`を先に作成する）。
別ターミナルでトークンを環境変数に設定して送信する。

```sh
DEVICE_TOKEN=dev-device-01 npm run sim -- --device stackchan-01
DEVICE_TOKEN=dev-device-02 npm run sim -- --device stackchan-02 --image /absolute/path/frame.jpg
DEVICE_TOKEN=dev-device-01 npm run sim -- --device stackchan-01 --frames /absolute/path/jpeg-frames
```

`--image`は1枚を繰り返す。`--frames`はディレクトリ内のJPEGを名前順に繰り返す。
未指定なら動く合成顔のJPEGを生成。`--fps`は0超〜10（既定2）。
`--base https://<worker-domain>`で公開BEにも同じクライアントを接続できる。
`--room`も指定可能。実トークンは環境変数で渡し、Gitやコマンド履歴へ直接書かない。
通常のCLIクライアントはactionを標準出力へ表示する。ローカルモニター/カメラブリッジは`npm run demo`の機能。

## 通信契約と実装の境界

[通信仕様](../doc/communication_protocol_v1.md)を参照。

- 本体ごとに独立したWS。FWはBearer、制御FEはHttpOnly Cookieで認証する。
- JPEGは`[uint32 BE frame_id][JPEG]`。再接続ごとにstream_idを更新する。
- FEは`session`/`stream`受信後に描画し、受信フレームごとに`frame_ack`を返す。
- controllerのみ`detection`を送信し、5秒ごとに`heartbeat`を送る。
- FWはactionの古いseqを無視し、5秒ごとにdevice_statusを送る。
- 模擬FWからのactionの表示はローカルモニター経由。BEは一般viewerへactionを配信しない。
  BEが発行した同じ指令はbehavior.commandとしてFEに届き、ローカル受信モニターと照合できる。
- mindは対象本体のFEにのみ送る。相手ロボットの判断には公開台詞と動作のみ渡す。
- dialogueは同じroomの全viewer WSへ届く。idで重複を除去し、dialogue_historyは表示専用として扱う。
- 初回の認証済みFW接続で性格を6種類からランダムに決める。profilesで初回だけ明示指定も可能。
  同じroom＋device_idの性格・感情・本音・親しみ・最近6件の体験と累計件数・自分の公開会話10件をDOへ保存する。
  再接続・Worker再起動後も復元し、memoryイベントで保存状況をFEへ送る。保存済み性格はprofilesより優先。
  新streamでは映像・検出・動作・seq・未処理会話をリセットし、古い指令を再実行しない。
  画像・人物情報は保存しない。部屋全体の表示用会話ログとログイン試行はメモリー内のみ。
- ローカルの記憶はback/.wrangler/state、公開BEの記憶はDOの保存領域に置く。両者は別の個体履歴。
  ローカルの保存領域を残せばデモの起動ごとに再抽選しない。部屋・device_id変更時は別個体になる。
- 性格: curious（好奇心旺盛）、shy（照れ屋）、cheerful（陽気）、calm（おっとり）、cautious（慎重）、playful（いたずら好き）。
  性格ごとの説明をDecisions / Responsesへ渡す。固定の表情コピーではなく、個体の受け止め方に反映する。
- 現段階は標準WebSocket APIとタイマーを使用し、接続中はDOを休止しない。運用費用最適化は未対応。

## 検証

```sh
npm run typecheck
npm run test:unit
npm run test:e2e
npm run build
```

E2Eは別ポート8789・inspector9230でテスト専用Wranglerを起動する。開発用`.dev.vars`は使わず、
サンプルから独立した設定を一時作成する。テストの終了時にそのプロセスと一時設定を片付ける。
外部OpenAIへの通信は行わない。`build`は公開用設定のdry runで、アップロードしない。

さらに8792・inspector9232で、Decisions＋Lunaの実APIアダプターにテスト専用のローカル応答を注入する。
2台の生成された会話文と本音、相手の非公開情報が入力に混ざらないこと、トークン計測、
生成待ち中の映像/顔追跡、429/不正応答/3秒タイムアウト時の切替と再試行抑制、相手再接続中の古い結果破棄を確認する。
初回ランダム割当、再接続・Workerプロセス再起動後の感情/本音/親しみ/体験復元も確認する。
テスト用の呼び出し記録APIと代替通信先はテストエントリーだけにあり、公開Workerへは含めない。
これは実OpenAIへの疎通や日本語の生成品質を確認するテストではない。

## Decisions＋Lunaを実APIで使う

`.dev.vars`に`OPENAI_API_KEY`、または1Passwordの対象フィールドを指す`OPENAI_API_KEY_REF`を設定する。
キーそのものはチャット・Git・コマンド引数へ書かない。個人の1Passwordデスクトップ認証を使う場合は、
設定 → 開発者 →「1Password CLIと連携」を有効にする。参照先の指定項目だけを読み、他の保管庫・項目は列挙しない。
`op`がPATHにない場合は`OP_BIN`に実行ファイルの絶対パスを設定できる。

```dotenv
OPENAI_API_KEY_REF="op://<vault>/<item>/<field>"
```

```sh
npm run check:openai
npm run demo:openai -- --same-image
```

**通常の `npm run demo` / `npm run dev` / `npm run test:e2e` はモックで動く。**
APIキーや以前の実API設定が`.dev.vars`にあっても、通常のデモとdevは`AI_MODE=mock`を強制し、キーをWorkerへ渡さない。
E2EのAPIアダプター試験もローカルの偽応答だけを使う。

実APIデモは、ターミナルで`npm run demo:openai`を明示的に実行した場合だけ開始する。
既定は**起動から60秒、全ルーム・全デバイス合計30リクエスト**の先着上限。
Decisionsの観察・意向選択とResponsesの文章生成を合算し、失敗・タイムアウトも送信前の予約時に1回と数える。
複数質問を含むDecisionsもHTTPリクエストとして1回。回数制限は金額の上限ではない。
時間切れでは進行中のリクエストも中断する。上限後はBEが新規送信を拒否し、デモも終了する。
画面の再読み込み、デバイス再接続、同じセッションのWorker再起動で回数・期限はリセットされない。
もう一度使う場合は、再度コマンドを明示的に実行する。

```sh
# 必要な場合だけ時間・回数を指定（上限: 600秒 / 1000回）
npm run demo:openai -- --seconds 120 --max-calls 50
```

BEは実APIモードでも、有効な期限・回数・セッションIDが揃わなければAPIへ送信しない。
開始設定は起動スクリプトが一時ファイルへ生成する。キーの設定だけでは起動許可にならない。
`/health`の`paid_session`に`active/reason/expires_at/max_calls/used_calls`を返す。
`reason`は`mock/not_started/expired/call_limit`、実行可能時は`null`。設定・使用回数はBEで強制する。
上限は予約済み回数なので、送信前の中断も含み実際の課金リクエスト数より多くなる場合がある。
実APIの自動再開や上限到達後の自動モック切替はしない。

`check:openai`は合成画像のpredicate、意向のchoice、本音・会話文の生成を各1回、計3リクエストで確認する。
生成文と成功した呼び出しの入出力トークン・遅延だけを出力する。API利用料が発生する。
`demo:openai`の前に起動中の`npm run demo`をCtrl+Cで止める。
`--same-image`はデバイス認証・個体の状態を分離したまま、同じframe_idに同じ合成JPEGを使う。
カメラやファイルを指定した場合はそちらが優先される。

デモはキーを起動時に解決し、Git対象外の`.wrangler/openai-*`内へ権限0600の一時`.dev.vars`として渡す。
正常終了時に削除する。強制終了で残った一時ディレクトリは、デモを止めてから削除する。
1Passwordを使う場合、元の`.dev.vars`へキーの実値をコピーしない。

実APIモードではカメラ映像がDecisions APIへ送られる。文章生成へは画像を再送せず、
観察結果と本人の仮想状態、公開会話だけを送る。画面上部でモード、各本音の下で生成元を確認する。
モック・実生成・失敗時のテンプレートを区別し、decisionには成功した呼び出し別のendpointと使用量を付ける。
合成顔で人物が検出される保証はない。実写の認識・生成品質は別途確認する。

2026-10-18に、1Password経由のプロジェクトキーで画像predicate・意向choice・Luna文章生成の
3リクエストの成功を確認した。ローカルの2台でも、実APIによる挨拶/返答・個別の本音・
FWシミュレーターへの指令受信まで確認済み。人物なしの観察結果でも同室の相手への挨拶を選べる。
合成JPEGでの検証であり、実写認識の精度・実機・公開環境の検証は別途行う。

## 公開BEへの移行

`wrangler.local.jsonc`はローカル確認用。`wrangler.jsonc`は公開用で、ラボのassetsを含めない。
公開用はsecret未設定ならアプリAPI/WSを503で拒否する。

1. Cloudflareの利用先アカウントを選び、`npx wrangler login`で認証する。`npx wrangler whoami`でメールとアカウントIDを確認し、公開時は`CLOUDFLARE_ACCOUNT_ID`を明示して別アカウントへの公開を防ぐ。
2. `ROOM_CONFIG`にroomと本体を登録する。各本体のデバイストークンとroom制御トークンは別々の乱数にする。
3. 以下を設定する（値はプロンプトへ入力する）。ローカル用の既知トークンを流用しない。

```sh
npx wrangler secret put ROOM_CONFIG
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ALLOWED_ORIGIN
```

ROOM_CONFIGの形:

```json
{
  "main": {
    "control_token": "<random-room-control-token>",
    "devices": {
      "stackchan-01": "<random-device-token-01>",
      "stackchan-02": "<random-device-token-02>"
    }
  }
}
```

4. **FEとAPI/WSは同じoriginにする。** ALLOWED_ORIGINはブラウザに表示されるFEの正確なoriginを設定する。
   公開用設定には次のassetsと`front/`のビルドフックを設定済み。初回は`npm --prefix ../front ci`でFEの依存関係もインストールする。Workersと一緒に配信する。
   WorkerはAPI/WSを処理し、それ以外をassetsへ渡す。これなら同一originのCookie認証を維持できる。

```json
{"assets":{"directory":"../front/dist","binding":"ASSETS","run_worker_first":true}}
```

別々のpages.dev / workers.devドメインをそのまま組み合わせる構成は現契約の対象外。
別ホスティングなら同じ公開originの`/api/*`と`/ws/*`をBEへプロキシする。

5. `npm run build`で公開ビルドを確認し、公開する段階で`npm run deploy`を実行する。
6. `/health`、FWの`--base`接続、FEログイン、2台同時中継、切断/再接続を公開URLで検証する。

### 初回公開先とデプロイ用認証

2026-10-18に専用Worker `stackchan-ai-vision` を手元のWranglerから初回公開した。
公開先は `https://stackchan-ai-vision.k-i-wrd-setuna-g.workers.dev`、
ヘルスチェックは `/health`。既定は `AI_MODE=mock`、実APIセッションは無効。
フロントは上記のassetsから同じWorkerの `/` へ配信する構成。
`ALLOWED_ORIGIN`はこの公開URLに設定済み。

CI用にはアカウント所有APIトークンを使い、対象をこのWorkerだけに限定した
`Individual Workers Editor`を付与する。既存WorkerへのBE・FE更新に使う。
Workerの新規作成や他プロジェクトの操作は権限の対象に含めない。
今回発行したトークンは2026-10-25まで有効。
リポジトリのActions Secretsに`CLOUDFLARE_API_TOKEN`と`CLOUDFLARE_ACCOUNT_ID`を登録済み。
期限前にCloudflare側で更新し、Actions Secretも差し替える。

`.github/workflows/deploy-back.yml`はmainへのpushで実行する。型チェック、単体テスト、
モックE2E、公開ビルド、フロントのブラウザ結合確認が成功したら既存Workerへデプロイし、
`/health`・フロント画面・顔検出アセットと実APIの停止状態を確認する。
Actions画面からmainを指定して手動実行も可能。同時デプロイは直列化する。
FEの依存インストールとビルドも同じCIへ統合する。Cloudflare上の既存secretをそのまま維持し、
OpenAIキーや部屋の認証情報をGitHubへコピーする必要はない。

アカウント固有の設定・secret・デプロイトークンはGit対象外の
`back/.wrangler/deploy/<account-id>/`に保存する。secretやトークンをコミットしない。
通常の更新時は既存secretを保持し、`--secrets-file`はsecretを設定・変更するときだけ指定する。

```sh
# back/で、今回用の認証情報を読み込んで更新する
set -a
. .wrangler/deploy/<account-id>/deploy-token.env
set +a
npm run deploy
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
```

### 公開環境でDecisions＋Lunaを有効にする

現実装には画像観察・意向選択・文章生成のアダプターを含む。実APIの疎通/品質確認は上記のスモークテストで別途行う。
`OPENAI_API_KEY`をsecretへ設定する。公開環境でも`AI_MODE=decisions`だけではAPIは動かない。有効な`PAID_SESSION_ID`（開始ごとに新しいID）、`PAID_SESSION_UNTIL`（期限のUnixミリ秒）、`PAID_SESSION_MAX_CALLS`（1〜1000）を明示設定して初めて送信可能になる。公開運用の開始UIは未実装。
API利用料が発生する。設定変更だけで意図せず呼び出さないよう、既定値は常にmock。

```sh
npx wrangler secret put OPENAI_API_KEY
```

1リクエストで画像の8つのpredicate、見える表情のchoice、個体自身の5つの感情scoreを評価する（計14問）。
笑顔のほか眉をひそめる・目を見開く・口を開く・涙を観察し、悲しげ/険しい/驚いたような見た目も分類する。
人間の内心を測定するものではない。人物未検出・不確かな場合は画面で判別不能として扱う。
感情scoreの入力は画像、自分の性格・前の感情・親しみ・前の本音、公開会話、最近6件の自分の体験。
scoreの0〜4の加重平均を4で割り、5感情の0〜1へ正規化する。BEは固定加算・減衰で上書きしない。
相手への親しみの台帳だけは同一受信会話につき1度、BEで更新する。
その後の別リクエストで、更新済みの感情と観察から自身の意向をchoiceで選ぶ。
choiceの候補はobserve/avert/restと、オンライン相手へのgreet、受信挨拶へのreply、返答を非言語で受け止めるlisten。
同室の新しい相手へのgreetは人物検出を必須にしない。合成映像を人間と判定しない場合も、相手と会話できる。
相手のmind/感情/親しみはリクエストへ含めず、公開済みの台詞・動作だけを参照する。
意向維持中はchoiceを省略する。本音と会話は`gpt-6-luna`のResponses APIで1回にまとめて生成する。
初回・意向/宛先変更・挨拶や受信会話・感情の0.15以上の変化が生成候補。本体ごとに生成開始の間隔を最低2秒あける。
同じ意向の文は再利用する。`reasoning.effort=none`、`max_output_tokens=256`、`store=false`。
生成対象はthoughtとpublic_textだけ。listen/observe/avert/restはpublic_text=null、発話の連鎖を増やさない。
Decisions失敗時は状態を維持する。文章生成のみの失敗・refusal・不正応答ではテンプレートを使い、
generation.provider=fallbackで表示する。生成の再試行は通常10秒、429は通常30秒、認証等は60秒休止する。
通信先は固定の`https://api.openai.com/v1/decisions`と`https://api.openai.com/v1/responses`。
本体ごとに多重実行せず、Decisionsは各4秒、文章生成は3秒でタイムアウトする。
対象streamの変更・古い結果は破棄する。実機に送る角度・表情・時間はBEが確定する。

### 同じ画像・同じ直前感情で受け止め方を比較する

```sh
npm run check:affect
```

指定済みのキーで3リクエストだけ実行する。合成JPEGを1枚生成し、直前の5感情をすべて0.5に揃え、
curious＋歓迎された交流、shy＋同じ交流、curious＋過去の緊張した体験、の3ケースを比較する。
画像と直前値を固定し、性格・体験による差、観察結果、各感情のconfidenceと使用量を出力する。
2026-10-18の実API試験では性格による照れの差と、体験による安心感の差を確認した。
これは合成画像でのロボットの仮想感情の検証。実写での人物表情分類の精度確認は別途行う。

### 人の新しいアクションへの反応

新しい画像の特徴を2回連続で確認して、手上げ・笑顔の開始などをhuman_actionにする。
高値0.8以上2回で開始、低値0.3以下2回で解除。中間値は確認をやり直す。人物0.8以上の場合のみ表情/手上げを開始する。
成立中は同じイベントを発火しない。解除後に再成立すれば新イベントとして反応できる。同じ特徴の開始は最低6秒間隔。
新イベントと自分の最近の体験を意向・本音の生成へ渡し、6秒維持中でも再評価する。
同じchoiceの定期評価ではFW指令を繰り返さない。decision.reactionと画面で、新しい指令を発行したか確認できる。
動作中は割り込まず、10秒以内のイベントだけ反応を確定する。再接続では確定済み観察状態のみ保存し、未反応イベントを再生しない。

E2Eは同じ手上げで好奇心旺盛がhappy、照れ屋がavert、その体験後の照れ屋がnodを選ぶ固定モデル応答を使う。
6秒の意向維持への割り込み、同じ手上げを8.5秒以上続けても反復しないこと、解除後の再反応、実FWクライアント受信を検証する。
これは静止画の見た目の変化であり、動画の軌跡や人物の同一性を追跡する機能ではない。

## RTTとペースの比較

各カードの「通信・APIの計測」で、観察/感情・意向・本音/会話のAPI往復時間を別々に表示する。
p50/p95、実際の開始間隔、失敗数、BE判断処理全体、映像受信fps、FWアップロード/指令ACK往復も確認できる。
通常の画面配信は集計値だけ。計測JSONを保存ボタン、または次のCLIで有界の生標本を要求して取得できる。画像・音声・プロンプト・キーは記録しない。

```sh
npm run metrics -- --seconds 30 --output metrics-baseline.json
```

公開環境では--base、--origin、--room、--devicesを指定する。OriginはBEで許可したFEのOriginに合わせる。
CLIもviewerとして画像受信ACKを返すため、viewer数は比較実験の間で揃える。
CLIのobservation_windowは計測開始後に始まったAPI/判断だけを抽出した統計。通常画面は直近の保存標本の統計。
transportのRTTは現streamの最大120標本、FPSは直近30秒/最大120枚であり、CLIの計測窓そのものとは区別する。
API直近120試行・判断60回と累計試行数はDOへ保存し、再起動でも復元する。通信側の直近RTTはstream単位でリセットする。
status/usageが不明な失敗はnull。失敗は請求額を確定できないため、usage合計を総請求額と解釈しない。

back/.dev.varsへ任意で設定してデモを起動し直す。OpenAI用の一時設定にもこれら3項目だけを明示的に引き継ぐ。

```dotenv
STREAM_FPS="2"
EVAL_INTERVAL_MS="2000"
NARRATION_INTERVAL_MS="2000"
```

STREAM_FPSは1〜10（demoは範囲外の設定を起動時に拒否）、判断間隔は500〜10000ms、本音生成間隔は1000〜30000ms。既定値は上記。
まず2fps/2000msを記録し、次にSTREAM_FPSだけ4へ変更して、API呼び出しを増やさず表示を滑らかにできるか比較する。
その後に判断間隔を変更し、APIのp95・エラー/タイムアウト・画像の古さ・破棄数を比較する。
実FWのfps設定はFW側にも適用する。BEが勝手にFW送信レートを変える機能や、最適値の自動決定は追加していない。

frame_receivedとaction_ackに対応したローカルFWシミュレーターで通信RTTを計測する。実FWがACKに未対応なら該当欄は未計測。
BE画像受信→FW受信ACKは撮影開始→モーター完了の時間ではない。FE受信ACKも描画前であり、GPU描画時間とは区別する。
音声入力・文字起こしは設計書の拡張候補を参照。現在はマイクを取得せず、APIにも音声を送らない。

## FE / FWとの共有型

通信契約は[`src/protocol.ts`](src/protocol.ts)へ集約した。送受信union、role別の型、感情・本音・動作・公開会話の型をここから参照する。
BEは送信payloadを型チェックし、受信JSONは`parseClientMessage`で検証してから利用する。
`fw-simulator.mjs`も同じファイルの`serializeClient` / `parseDeviceServerMessage`を使い、JSDoc＋strictなcheckJsで通信部分を含むファイル全体を検査する。
他チームのFEからは`import type { ClientMessage, ServerMessage } from '../back/src/protocol'`のように型を参照できる。
FWがC++の場合も、この型と[通信仕様](../doc/communication_protocol_v1.md)を基準に実装する。
`npm run typecheck`はBE・シミュレーター・不正payloadを検出する型テストをまとめて実行する。
送信できる型と、ネットから届いたJSONの検証は別の責務。接続世代・順序・認証・期限のチェックはBEに残す。
