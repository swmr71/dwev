# devbox

リポジトリ + ブランチ + 環境変数を指定すると、Dockerで開発用サーバーを立ち上げてプレビューURLを発行するWebサービス(MVP)。

## できること

- Web画面からプロジェクトを作成 → `git clone` → `docker build` → コンテナ起動 → プレビューURL発行
- `Dockerfile` があればそれを使用。無ければ中身から判定して自動生成(下の「自動判定」を参照)
- 環境変数はAES-256-GCMで暗号化して保存(画面・APIにはキー名だけ返す)
- ビルドログ/実行ログの表示、停止、再ビルド、削除

## セットアップ

```bash
cp .env.example .env     # ADMIN_TOKEN と PREVIEW_HOST_TEMPLATE などを編集
docker compose up -d --build
```

`.env.example` に項目が増えたあとは、`.env` を作り直さず `npm run env:sync` で、足りない項目だけを `.env` の末尾に足せます
(既存の行は変えません。`-- --dry-run` で、足さずに確認だけできます)。

`TRAEFIK_PORT` (既定 8080) を Cloudflare Tunnel の転送先 (`http://<このホスト>:8080`) に指定します。
ワイルドカード用に、`*-dev.clusters-prj.com` のようなホスト名をトンネルへ流す設定が別途必要です。

ローカル試験だけなら `PREVIEW_HOST_TEMPLATE={id}.localtest.me` (既定) で `http://<id>.localtest.me:8080` が開けます。

## ⚠️ 公開前に必ずやること

このサービスは「他人が書いたコードを自分のサーバーで実行する」ものです。

1. **専用VMで動かす**(Bitwarden 等が同居する DockerV は避ける)
2. `scripts/egress-firewall.sh` を適用して、開発コンテナから社内LAN (`10.0.0.0/8` など) と VM 本体への通信を遮断し、適用後に表示される確認コマンドで検証する。再起動後も残すには `scripts/devbox-egress.service` を入れる(手順はファイルの先頭に記載)。あわせて Proxmox の VM ファイアウォール(net0 の Firewall にチェック)でも `10.0.0.0/8` 宛てを OUT で DROP にしておくと二重になる
3. **管理者用の `/admin` と `/api/admin` だけ** を Cloudflare Access で保護する(下の「利用者のログインと承認」を参照)。利用者が使う `/` は Access で守らない
4. 可能なら gVisor (`DOCKER_RUNTIME=runsc`) を導入
5. 「既知のリスク」(下)を読んで、受け入れられるか判断する

`docker.sock` をマウントしているため、devbox 自体が侵害されるとホスト全体が危険になります。

## 利用者のログインと承認

利用者は GitHub アカウントでログインします(GitHub には、ユーザー名とアイコンの取得しか求めません。リポジトリへの権限は取りません)。

- 初めてログインした人は **「承認待ち」** になり、管理者が `/admin/` で承認するまで、何も作れません
- 1人あたりの上限は、既定で **プロジェクト3件・同時起動1件**(ビルド中・順番待ちも数える)。管理画面から人ごとに変えられます
- 他人のプロジェクトは、一覧に出ず、URLを知っていても 404 になります
- 管理画面で「凍結」すると、ログインが無効になり、その人の動いているものも止まります

### 設定手順

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**
   - Homepage URL: `https://devbox.clusters-prj.com`
   - Authorization callback URL: `https://devbox.clusters-prj.com/auth/github/callback`
2. 作成後の **Client ID** と、**Generate a new client secret** で出した値を、`.env` に書く(`PUBLIC_URL` / `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`)
3. `docker compose up -d devbox` で反映
4. **Cloudflare Access の設定を変える**: Zero Trust → Access → アプリケーション で、`devbox.clusters-prj.com` 全体を守っているアプリを、次のパスだけに絞る
   - `devbox.clusters-prj.com/admin`(`/admin/` 以下も含む)
   - `devbox.clusters-prj.com/api/admin`

   ホスト全体を守ったままだと、利用者がログイン画面まで来られません。逆に、絞り忘れると、管理画面が管理トークンだけで守られる状態になります。
5. 自分自身も、一度 GitHub でログインして「承認待ち」になり、`/admin/` で自分を承認する

### 管理画面 (`/admin/`)

管理トークン(`ADMIN_TOKEN`)でログインします。承認待ちの人の承認・拒否、人ごとの上限の変更、凍結、全プロジェクトの停止・削除ができます。

## 既知のリスク

- **プレビューは、あなたのドメイン(`clusters-prj.com`)の下で、他人が書いたコードを配信します。**
  同じドメインの別サイトの Cookie が、プレビューのコードから読まれたり、上書きされたりする可能性があります
  (devbox 自身の Cookie は `__Host-` 付きで、これを避けています)。また、悪用されると、ドメイン自体の評判が下がります。
  不特定多数に開くなら、プレビュー専用に別のドメインを用意するのが、根本的な対策です。
- 開発コンテナからは、インターネットに自由に出られます(社内LAN・VM本体は遮断)。外部への攻撃やマイニングに使われると、
  家の回線のIPアドレスから出ていくことになります。
- 他人のコードを動かす以上、コンテナの脱出に対する備えは、Docker の標準的な分離と制限(権限の削除、リソース制限)だけです。gVisor の導入を推奨します。

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
   IDLE_STOP_MINUTES=60
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
| ビルド | `docker build` にもメモリ・CPU・時間の上限をかけ、実行時と同じ `devbox-net` で動かす(社内LAN・VM本体への遮断がビルド中にも効く) |
| 入力 | リポジトリは `https://<許可ホスト>/owner/repo` のみ / ブランチ・env名を厳格に検証 |
| リソース | 利用者ごとのプロジェクト数・同時起動数の上限 / 全体の同時稼働数(超えたら順番待ち) / 同時ビルド数上限 / clone タイムアウト / リポジトリサイズ上限 / 最大稼働時間 |
| ネットワーク | 管理APIと docker-socket-proxy はユーザーのコンテナと別ネットワーク。社内LAN・VM本体への通信は遮断 |
| 認証 | GitHub ログイン + 管理者の承認制。セッションは HttpOnly / SameSite=Lax / `__Host-` 付き Cookie(DBにはハッシュだけ保存)。変更系は same-origin のみ |
| 表示 | エラーメッセージからサーバー内部のフォルダの場所を伏せる |

## API

### 利用者向け

GitHub でログインして Cookie を持っていて、かつ「承認済み」の人だけが使えます(`/api/me` はログインだけで可)。
他人のプロジェクトは 404。変更系のリクエストは、同じ出どころ(same-origin)からのものだけを受け付けます。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/auth/github` | GitHub のログインへ(ブラウザで開く) |
| POST | `/auth/logout` | ログアウト |
| GET | `/api/me` | 自分の状態・上限・使用量 |
| GET | `/api/info` | 全体の稼働数など |
| GET | `/api/projects` | 自分のプロジェクト一覧 |
| POST | `/api/projects` | 作成 `{name, repoUrl, branch, port, env, autoStart}` |
| PATCH | `/api/projects/:id` | name / branch / port / env の更新(反映は再ビルド後) |
| POST | `/api/projects/:id/start` | ビルド→起動(再ビルド兼用) |
| POST | `/api/projects/:id/stop` | 停止 |
| DELETE | `/api/projects/:id` | コンテナ・イメージ・ログ・レコードを削除 |
| GET | `/api/projects/:id/build-log?offset=N` | ビルドログの差分 |
| GET | `/api/projects/:id/runtime-log` | 実行ログ |

### 管理者向け

すべて `Authorization: Bearer <ADMIN_TOKEN>` が必要(Cloudflare Access でも保護する)。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/admin/info` | 全体の状態(稼働数・承認待ちの人数・既定の上限など) |
| GET | `/api/admin/users` | 利用者の一覧 |
| PATCH | `/api/admin/users/:id` | `{status: "approved"\|"pending"\|"suspended", maxProjects, maxRunning}`(上限は null で既定に戻す)。承認を外すと、ログインを無効にして、動いているものを止める |
| GET | `/api/admin/projects` | 全プロジェクト(持ち主つき) |
| POST | `/api/admin/projects/:id/stop` | 停止 |
| DELETE | `/api/admin/projects/:id` | 削除 |

## 開発

```bash
npm install
ADMIN_TOKEN=dev npm start    # http://localhost:3000
npm test
```

Node 22.5+ が必要(組み込みの `node:sqlite` を使用)。

## 自動判定(Dockerfile が無いとき)

| 見つかったもの | 起動コマンド |
|---|---|
| `manage.py`(Django) | `migrate --noinput` のあと `runserver 0.0.0.0:$PORT` |
| `requirements.txt` / `pyproject.toml` に `fastapi` | `uvicorn <main or app>:app --host 0.0.0.0 --port $PORT`(`main.py` / `app.py` / `app/main.py` / `src/main.py`) |
| 同じく `flask` | `flask --app <app or wsgi or main> run --host 0.0.0.0 --port $PORT` |
| `package.json` | `dev`、無ければ `start`。`pnpm-lock.yaml` / `yarn.lock` があれば pnpm / yarn。Vite と Next には待ち受け先の引数を足す |

- Python は `python:3.12-slim`、Node は `node:22-slim`。上のどれにも当てはまらなければ、Dockerfile を置いてもらうエラーになります
- `package.json` と Python のファイルが両方ある場合は、`manage.py` がなければ Node(フロント用)を優先します
- **Django は、プレビューのホスト名を `ALLOWED_HOSTS` に入れる必要があります**(入れないと `DisallowedHost` で 400 になる)。
  環境変数で渡して settings で読む(例 `ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", "*").split(",")`)のが簡単です
- Vite の新しい版は `server.allowedHosts` に無いホストを断ります。プレビューのホスト名を許可してください

## 制約・今後

- 開発サーバーは `0.0.0.0` で待ち受ける必要あり(`HOST` / `PORT` 環境変数を渡します。Vite なら `--host` が必要)
- プライベートリポジトリ未対応(GitHub App 連携が必要)
- ブラウザ内エディタ (code-server) は未実装
- 新規登録の通知は未実装(管理画面を開くと「承認待ち」が出る)
- ログインの試行回数の制限は未実装
- 利用者のアカウント削除・データのエクスポートは未実装(凍結のみ)
