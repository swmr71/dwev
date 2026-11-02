# hello-devbox

devbox の動作確認用サンプル。依存パッケージなしの小さな Node サーバーです。

- `npm run dev` で起動(`PORT` / `HOST` / `GREETING` 環境変数に対応)
- `/healthz` が `{"ok":true}` を返す
- Dockerfile は置いていません(devbox が `package.json` から自動生成します)

devbox で試すとき: 環境変数に `GREETING=こんにちは` を入れると、ページの見出しが変わります。
