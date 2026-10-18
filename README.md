# stackchan-ai-vison

## 開発ドキュメント

- [通信仕様 v1.7（FE / BE / FW）](doc/communication_protocol_v1.md)
- [設計書 v1.7](doc/stackchan_ai_vision_spec_v1.md)

通信実装は通信仕様を参照してください。同一roomへの複数デバイス参加など、設計案からの変更点も記載しています。

## ローカルE2E環境

[BEとFWシミュレーターの起動手順](back/README.md)を参照してください。
`back/`で`npm ci`、`npm run demo`を実行し、http://127.0.0.1:8787 を開きます。
