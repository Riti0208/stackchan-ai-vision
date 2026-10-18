# RGB565カメラの暫定互換プロファイル

SCFW v2のformat 1は引き続き **RGB565 little-endian（LE）**。160×120、16バイトのヘッダー、flags=0、正確なパケット長など既存の検証条件は変えない。JPEG生成時の16bit RGB565からRGBへの展開も維持する。

## 背景と確認範囲

FWコミット `bc9b3c5` の `fw/src/Vision.cpp` はヘッダーにformat 1を記録し、カメラの `fb->buf` を `memcpy` で送信領域へコピーする。送信時のbyte swapはない。同コミットの `fw/src/WssTransport.cpp` はsessionの `rgb565le-v2` と送信パケットのformat 1を厳密に確認する。

Espressifの [JPEG変換実装](https://github.com/espressif/esp32-camera/blob/master/conversions/to_jpg.cpp) は、RGB565を既定でMSB先頭（big-endian）として解釈する。`frame2jpg_cb` はこの変換へカメラバッファを渡す。[公式ヘッダー](https://github.com/espressif/esp32-camera/blob/master/conversions/include/img_converters.h) も、既定がbig-endianで、多くのESP32カメラ出力に対応すると説明する。これは上流ソース上の根拠であり、実機に組み込まれたドライバー版や実機rawバイトの測定結果ではない。

M5の [GC0308カメラ例](https://docs.m5stack.com/en/arduino/stackchan/camera) はRGB565バッファを `pushImage` へ渡す。描画系には [独立したbyte swap設定](https://github.com/m5stack/M5GFX/blob/master/src/lgfx/v1/LGFXBase.hpp) があるため、本体プレビューの色が正常でも送信バッファがLEである証明にはならない。

ローカルのBEエンコーダーで色バー・灰色階調・色勾配を確認した。BEデータをLEとして復号すると、輪郭位置を保ったまま灰色階調が虹色の縞になる。BEデータに明示的なbig指定を適用すると、同じ色の正規LEデータと生成JPEGがバイト単位で一致する。実機viewerのJPEGからの近似逆swapは、JPEGの不可逆圧縮誤差が増幅されるため色を復元できず、原因確定には使用していない。

## 明示設定と適用範囲

`RGB565_BIG_ENDIAN_DEVICES` は、MSB先頭のカメラバッファをformat 1と誤宣言する既知の個体だけを列挙する、comma-separated device IDの暫定互換設定。今回の本番設定対象は `stackchan-01`。正規LEのシミュレーター `stackchan-02` は対象に含めない。ローカル/OpenAIデモはこの設定を省略し、正規LEとして扱う。

```dotenv
RGB565_BIG_ENDIAN_DEVICES="stackchan-01"
```

接続側は認証済みdevice IDを設定一覧と完全一致で照合し、対象だけ `encodeRawFrame(frame, 'big')` を呼ぶ。それ以外は引数を省略するか `'little'` を渡す。画像の内容からbyte orderを推測しない。送信者の未認証パラメーターで切り替えない。format 1全体の意味、sessionの `rgb565le-v2`、ヘッダー検証は変更しない。

`encodeRawFrame` の指定は呼び出しごとに適用され、再利用するJPEGエンコーダーにbyte orderを保存しない。異なる個体の復号へ設定が漏れない。パケット自体も書き換えない。

この設定は既知のFWとの互換を保つための措置であり、BEをformat 1として送ることを正規の契約にはしない。BE rawを正式に扱う場合は、別の明示formatとsession交渉を設計する。

## FW修正後の解除

FW側の最小修正は、カメラバッファがMSB先頭であることを確認し、送信領域へコピーするときに各画素の2バイトを交換してLEへ正規化すること。カメラが所有する元バッファの順序やプレビューを変更する必要はない。

修正FWがLEを送るようになったら、**同じ個体を互換設定から必ず外す**。LEデータにbigプロファイルを適用すると再び色が崩れる。FW更新とBE設定解除を合わせて行い、赤・緑・青・白・黒の色バーおよび灰色階調で確認する。実機rawの色バー1枚、または確認済みFWからの色バー送信で検証する。通常のJPEG画像だけによる逆変換を正確なraw診断の代用にしない。

## 回帰確認

```sh
cd back
node --experimental-strip-types --test test/raw-frame.test.mjs
```

正規LEの色、明示big指定の同一JPEG、指定なしBEの色崩れ、個体を切り替える呼び出し間の独立性、入力パケットの不変性、不正ヘッダー・寸法・flags・長さの拒否を確認する。外部API・実機への制御操作は行わない。
