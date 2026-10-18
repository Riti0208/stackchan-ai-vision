# 人物追従の方向点検（2026-10-18）

## 結論と実機確認の範囲

基準は「アップロード画像の左下に顔の中心があるなら、カメラを左下へ向ける」。人物自身の左手側や、ロボットに対面する観客の左右を使わない。

実機担当者がモニターの手動操作でも左右が逆と確認した。上下についてはその後「上下は合っている」と訂正した。この確認はDecisionsを通さないため、画像分類プロンプトだけでは左右反転を説明できない。

一度FW側のyaw反転を外す変更をpushしたが、方針を訂正して**そのFW変更をすべて撤回した**。既存FWをそのまま使用し、BE共通の送信境界 `toDeviceMotion()` でpanだけを反転する。BE内部のpan（左が負、右が正）とtilt、Decisionsの画像位置ラベルは変更しない。FW書き込みは不要であり、今回の検証でも書き込みは行っていない。
## コード経路と修正

1. Decisionsの同一perception要求に `person_horizontal` と `person_vertical` のchoiceが入る。
2. APIは画像中の対象中心の位置を返す。`left/lower` の信頼度が各0.65以上で、人物有り・鮮度・セッション等のガードを満たすと `coarseTarget()` は中央寄りならpanを0.2、tiltを0.16減らす。画像端のfar_left/far_lowerならpanを0.4、tiltを0.32減らす。
3. BEは正規化した**絶対目標値**をactionで送る。送信直前にpanだけを反転する。follow_personではFE detectionは方向を上書きしない。
4. FW Behaviorは `pan * 30°` と `tilt * 15°` に変換し、補間した角度を0.1°単位で `moveHead()` に渡す。
5. FWは従来の `Motion.move(-pan, 450 + tilt, speed)` のまま。BEが送信panを反転するので、既存FWのyaw反転と組み合わせて意図した方向へ動く。手動・追従・自由判断・keepaliveはすべて共通送信境界を使う。

正面（0,0）からの一回の応答例（中央寄りの帯。外側のfar_*は補正量が倍）:

| 画像中の顔中心 | Decisions | BE内部 pan / tilt | FW送信 pan / tilt | 既存FW yaw / pitch（0.1°） |
|---|---|---|---|---|
| 左下 | left / lower | -0.2 / -0.16 | +0.2 / -0.16 | -60 / 426 |
| 左上 | left / upper | -0.2 / +0.16 | +0.2 / +0.16 | -60 / 474 |
| 右下 | right / lower | +0.2 / -0.16 | -0.2 / -0.16 | +60 / 426 |
| 右上 | right / upper | +0.2 / +0.16 | -0.2 / +0.16 | +60 / 474 |
| 中央 | center / center | 目標を保持 | 同じ反転済み目標 | 目標を保持 |

`action`と`behavior.command`は実際にFWへ送った値を示す。手動HTTP応答とモニターの操作目標はBE内部基準（左が負・右が正）を維持する。シミュレーターの受信ログも送信値を保持し、ローカルE2Eのロボット表示はpanを内部基準に戻して描画する。

## Decisionsへの問い

従来も「画像上の左右・上下」を質問しており、逆向きに動くよう指示してはいない。ただし画像位置の分類の問いにモーターの符号説明が混在していたため取り除いた。新しい問いは次を明記する。

- 左上が原点、xは右へ、yは下へ増える。
- 「画像中で顔がどこにあるか」を返す。顔の向き・視線や「動いた後で画像がどちらへ流れるか」は答えない。
- 画像を鏡像・回転として読み替えない。顔が傾いていても同じ画像座標を使う。
- 左下の顔は `left / lower`、右上の顔は `right / upper`。各軸の外側20%では `far_left / far_lower`、`far_right / far_upper` を使う。
- 中央40–60%は保持。不確かな軸はunknown。モデルにサーボ角度やハードウェアの符号を選ばせない。

choiceとconfidenceを使う形式自体は[OpenAI公式Decisionsガイド](https://developers.openai.com/api/docs/guides/decisions)と一致する。プロンプトの明確化は実APIの位置分類精度の保証ではない。今回は課金APIを開始していない。

## 公式仕様との照合

- [M5Stack StackChan仕様](https://docs.m5stack.com/en/StackChan): GC0308、水平・垂直の2軸。垂直の推奨範囲5–85°に対し、現FWは30–60°内を使用する。
- [公式Arduino Servoサンプル](https://docs.m5stack.com/en/arduino/stackchan/servo): 0.1°単位、yaw正をLeft、pitch増加をUpと記載する。
- [工場FWのMCP説明](https://github.com/m5stack/StackChan/blob/main/firmware/main/hal/hal_mcp.cpp): yaw負を「your left」と記載する。公式資料間の左右の説明が一貫しないため、説明だけから実機の方向を確定できない。
- [工場FWのサーボ変換](https://github.com/m5stack/StackChan/blob/main/firmware/main/hal/hal_servo.cpp) と同梱BSPは、符号をさらに反転せず `zero + angle * 16 / 5 / 10` でraw位置に変換する。組付け・個体の実際の向きは実機確認が必要。
- [GC0308データシート](https://m5stack.oss-cn-shenzhen.aliyuncs.com/resource/docs/datasheet/core/K128%20CoreS3/GC0308.PDF) のPDF11ページ: P0:0x14のbit0はmirror、bit1はupside down。現FWはesp_camera_init後のmirror/flipを明示設定しておらず、実機設定値は未採取。[Espressif最新ドライバ初期値](https://github.com/espressif/esp32-camera/blob/master/sensors/private_include/gc0308_settings.h) はmirror/flip無しだが、書込済みFWにリンクされた版と同じかは未確認。
- raw→JPEGは画素順のまま変換し、RGB565の互換設定は各画素のバイト順だけを変える。FE表示もdrawImageで反転しない。APIには同じJPEGを渡す。これらのコードに左右・上下の画像反転処理はない。

## 残る注意点

小さな増分で追従するため、以前のBE目標が右上の場合、一回のleft/lowerで値は減るが、まだ右上の絶対値であることはある。BEは実際の首位置を受信していない。また3秒無指令での中央復帰や、ACK後の時刻競合による指令破棄は別の監査報告で確認されている。本修正はこれらを解決するものではない。

## 検証・反映

- FWのfw.ino/READMEを32fd566前と一致する状態に戻し、HeadPose.hとその追加テストを撤去した。他のFW変更は行わない。
- 全action種別とpan/tilt端点についてpanだけが反転し、seq・action・expression・durationと入力オブジェクトが保持されることを確認する。
- 四隅の応答解析と、Workerから送る左右反転済みの指令・上下維持を検証する。
- 手動leftを繰り返してもBE内部状態が送信時の反転で壊れず、-0.2→-0.4と進むことを検証する。keepaliveでも二重反転しない。
- BEの型検査・単体・ローカルE2Eを実施する。テストは偽APIのみ。実API開始・実機書き込みは行わない。
- 本番はBEデプロイだけで対応する。実機での修正後の物理動作は未確認。先のFW側修正を書き込んだ個体がある場合は、元FWに戻してから本BEと組み合わせる必要がある。
