import http from 'node:http';

// devbox は HOST=0.0.0.0 と PORT を環境変数で渡してくる
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT) || 3000;
const greeting = process.env.GREETING || 'Hello from devbox!';
const startedAt = new Date();

const page = () => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hello-devbox</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0f1117; color:#e8eaf0;
    font-family: system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  main { text-align:center; padding:24px; }
  h1 { font-size:clamp(28px,6vw,52px); margin:0 0 12px;
    background:linear-gradient(90deg,#a78bfa,#22d3ee,#4ade80); -webkit-background-clip:text; background-clip:text; color:transparent; }
  p { color:#8b93a7; margin:6px 0; }
  code { background:#1f2330; padding:2px 8px; border-radius:6px; color:#e8eaf0; }
</style></head>
<body><main>
  <h1>${greeting.replace(/[<>&]/g, '')}</h1>
  <p>このページが見えていれば、devbox のビルド → 起動 → ルーティングは成功です 🎉</p>
  <p>起動時刻: <code>${startedAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</code></p>
  <p>現在時刻: <code>${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</code></p>
  <p>listen: <code>${host}:${port}</code> / Node <code>${process.version}</code></p>
</main></body></html>`;

http
  .createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page());
  })
  .listen(port, host, () => console.log(`hello-devbox listening on http://${host}:${port}`));
