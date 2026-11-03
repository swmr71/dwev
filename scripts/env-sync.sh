#!/bin/sh
# .env.example に増えた項目を .env に足す(中身は env-sync.js)。Node が無いホスト(DockerV など)では Docker 経由で動かす。
#   sh scripts/env-sync.sh              # 足す
#   sh scripts/env-sync.sh --dry-run    # 足さずに、何が足されるかだけ表示
set -eu
cd "$(dirname "$0")/.."
if command -v node >/dev/null 2>&1; then
  exec node scripts/env-sync.js "$@"
fi
exec docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/w" -w /w node:22-slim node scripts/env-sync.js "$@"
