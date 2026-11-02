# devbox

リポジトリ + ブランチ + 環境変数を指定すると、Dockerで開発用サーバーを立ち上げてプレビューURLを発行するWebサービス(MVP)。

## できること

- Web画面からプロジェクトを作成 → `git clone` → `docker build` → コンテナ起動 → プレビューURL発行
- `Dockerfile` があればそれを使用。無ければ `package.json` の `dev` / `start` スクリプトで Node 用に自動生成
- 環境変数はAES-256-GCMで暗号化して保存(画面・APIにはキー名だけ返す)
- ビルドログ/実行ログの表示、停止、再ビルド、削除

## セットアップ

```bash
cp .env.example .env     # ADMIN_TOKEN と PREVIEW_HOST_TEMPLATE などを編集
docker compose up -d --build
```

`TRAEFIK_PORT` (既定 8080) を Cloudflare Tunnel の転送先 (`http://<このホスト>:8080`) に指定します。
ワイルドカード用に、`*-dev.clusters-prj.com` のようなホスト名をトンネルへ流す設定が別途必要です。

ローカル試験だけなら `PREVIEW_HOST_TEMPLATE={id}.localtest.me` (既定) で `http://<id>.localtest.me:8080` が開けます。

## ⚠️ 公開前に必ずやること

このサービスは「他人が書いたコードを自分のサーバーで実行する」ものです。

1. **専用VMで動かす**(Bitwarden 等が同居する DockerV は避ける)
2. `scripts/egress-firewall.sh` を適用して、開発コンテナから社内LAN (`10.0.0.0/8` など) と VM 本体への通信を遮断し、適用後に表示される確認コマンドで検証する。再起動後も残すには `scripts/devbox-egress.service` を入れる(手順はファイルの先頭に記載)。あわせて Proxmox の VM ファイアウォール(net0 の Firewall にチェック)でも `10.0.0.0/8` 宛てを OUT で DROP にしておくと二重になる
3. 管理画面 (`DEVBOX_HOST`) を Cloudflare Access で保護する
4. 可能なら gVisor (`DOCKER_RUNTIME=runsc`) を導入
5. 現状は管理トークン1つだけの認証。不特定多数に開く前に、ユーザー別ログイン・クォータ・アイドル自動停止が必要

`docker.sock` をマウントしているため、devbox 自体が侵害されるとホスト全体が危険になります。

## プレビューを外に公開する(専用トンネル + DNS自動作成)

起動のたびに `{id}-dev.clusters-prj.com` の DNS レコードを Cloudflare API で作り、停止・削除で消します。
同時に動かせる数は `MAX_RUNNING`(既定30)までで、満杯なら「待機中」になって空いた順に起動します。
DNS レコードは常に最大 `MAX_RUNNING` 件しか増えません。

### 手順

1. **プレビュー専用トンネルを作る**(既存の `ProxmoxTunnel1` とは別。PC で実行)
   ```bash
   cloudflared tunnel create devbox-preview     # UUID と ~/.cloudflared/<UUID>.json ができる
   ```
2. **DockerV に置く**
   ```bash
   mkdir -p ~/devbox/cloudflared
   # <UUID>.json を ~/devbox/cloudflared/ にコピーし、config.yml を作る
   cp ~/devbox/cloudflared/config.yml.example ~/devbox/cloudflared/config.yml   # <UUID> を書き換える
   ```
3. **API トークンを作る**: Cloudflare → My Profile → API Tokens → Create Token → Custom
   権限は *Zone / DNS / Edit* だけ、*Zone Resources* は対象ゾーン(clusters-prj.com)だけにする。
   ゾーンIDは、ドメインの Overview 画面の右側にある。
4. **`.env` に設定**
   ```
   PREVIEW_HOST_TEMPLATE={id}-dev.clusters-prj.com
   PREVIEW_SCHEME=https
   # PREVIEW_PORT は削除(または空)
   CF_API_TOKEN=...
   CF_ZONE_ID=...
   DNS_TARGET=<UUID>.cfargotunnel.com
   MAX_RUNNING=30
   MAX_RUNTIME_HOURS=8
   ```
5. **起動**: `docker compose --profile preview-tunnel up -d --build`

### 安全のための決まり

- 操作するのは `PREVIEW_HOST_TEMPLATE` の `{id}` に一致するホスト名だけ(`www` などには触れない)
- 削除するのは、devbox が作った印(comment: `devbox-preview`)の付いた CNAME だけ
- 手作りの同名レコードがあれば、上書きせずエラーにする
- 取り残し(強制終了など)は、起動時と30分ごとに自動で掃除する

### 既知の注意

- 停止中にそのURLを開くと、DNSが「存在しない」とキャッシュされ、再起動後もしばらく(数分〜)開けないことがある

## すでに入っている制限

| 項目 | 内容 |
|---|---|
| コンテナ | `cap-drop ALL` / `no-new-privileges` / 非特権 / メモリ・CPU・PID数の上限 / swap無効 |
| 入力 | リポジトリは `https://<許可ホスト>/owner/repo` のみ / ブランチ・env名を厳格に検証 |
| リソース | プロジェクト数上限 / 同時ビルド数上限 / clone タイムアウト / リポジトリサイズ上限 |
| ネットワーク | 管理APIと docker-socket-proxy はユーザーのコンテナと別ネットワーク |

## API

すべて `Authorization: Bearer <ADMIN_TOKEN>` が必要。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/projects` | 一覧 |
| POST | `/api/projects` | 作成 `{name, repoUrl, branch, port, env, autoStart}` |
| PATCH | `/api/projects/:id` | name / branch / port / env の更新(反映は再ビルド後) |
| POST | `/api/projects/:id/start` | ビルド→起動(再ビルド兼用) |
| POST | `/api/projects/:id/stop` | 停止 |
| DELETE | `/api/projects/:id` | コンテナ・イメージ・ログ・レコードを削除 |
| GET | `/api/projects/:id/build-log?offset=N` | ビルドログの差分 |
| GET | `/api/projects/:id/runtime-log` | 実行ログ |

## 開発

```bash
npm install
ADMIN_TOKEN=dev npm start    # http://localhost:3000
npm test
```

Node 22.5+ が必要(組み込みの `node:sqlite` を使用)。

## 制約・今後

- 開発サーバーは `0.0.0.0` で待ち受ける必要あり(`HOST` / `PORT` 環境変数を渡します。Vite なら `--host` が必要)
- Node 以外の自動判定は未対応(Dockerfile を置いてください)
- プライベートリポジトリ未対応(GitHub App 連携が必要)
- ブラウザ内エディタ (code-server) は未実装
- 無操作検知での自動停止は未実装(起動からの最大稼働時間 `MAX_RUNTIME_HOURS` のみ)
- ユーザー別クォータは未実装
