#!/usr/bin/env bash
# 開発コンテナ (devbox-net: 172.30.0.0/16) から、社内LAN・他のDockerネットワーク・
# リンクローカル(クラウドのメタデータ等)・VM本体(SSHなど)への通信を遮断する。
# インターネット宛は許可のまま。
#
# Docker ホスト(専用VM)で root で実行する。再起動で消えるので、永続化するなら
# iptables-persistent か systemd unit に登録すること。
#
# ※ 実環境での動作確認は未実施。適用後に必ず下の「確認」を行うこと。
set -euo pipefail

SUBNET="172.30.0.0/16"
CHAIN="DOCKER-USER"

# 既存ルールの重複を避けるため、先に devbox のルールを消す
(iptables -S "$CHAIN" | grep -- "-s $SUBNET" || true) | sed 's/^-A/-D/' | while read -r rule; do
  # shellcheck disable=SC2086
  iptables $rule
done

# 後に -I したものが上に来る。最終的な評価順は:
#   1) 同一サブネット内 (Traefik→コンテナ) は許可
#   2) 戻りパケット(ESTABLISHED)は許可
#   3) プライベート/リンクローカル宛はDROP
for dst in 169.254.0.0/16 192.168.0.0/16 172.16.0.0/12 10.0.0.0/8 100.64.0.0/10; do
  iptables -I "$CHAIN" -s "$SUBNET" -d "$dst" -j DROP
done
iptables -I "$CHAIN" -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -I "$CHAIN" -s "$SUBNET" -d "$SUBNET" -j ACCEPT

# --- VM本体への通信 (INPUT) ---------------------------------------------------
# DOCKER-USER は「VMの外へ出る通信 (FORWARD)」だけが対象。コンテナから VM 自身
# (SSH や、ホストで待ち受けているサービス) に向かう通信は INPUT を通るので別に塞ぐ。
# 他のルールを巻き込まないよう、devbox のルールには必ずコメントを付けて、そのコメントのものだけ入れ替える。
TAG="devbox-egress"
(iptables -S INPUT | grep -- "--comment $TAG" || true) | sed 's/^-A/-D/' | while read -r rule; do
  # shellcheck disable=SC2086
  iptables $rule
done
iptables -I INPUT -s "$SUBNET" -m comment --comment "$TAG" -j DROP
iptables -I INPUT -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$TAG" -j ACCEPT

# --- なりすまし対策 (補助サービスを使うとき) ----------------------------------
# 補助サービス(docker-compose.yml の DB など)を使うと、アプリのコンテナは、専用の閉じたネットワーク
# (172.30 の外のアドレス)にも入る。そのアドレスを「送信元」にして送ると、上の -s $SUBNET の遮断に
# 当たらない。そこで、devbox-net の入口(ブリッジ)で、送信元が $SUBNET でないものを落とす。
# ブリッジは、ゲートウェイのアドレス(172.30.0.1)から探す。devbox-net を作り直したら、再実行すること。
GW="${SUBNET%.*.*}.0.1"
BR=$(ip -o -4 addr show 2>/dev/null | awk -v gw="$GW/" 'index($4, gw) == 1 {print $2; exit}' || true)
if [ -n "$BR" ]; then
  iptables -I "$CHAIN" -i "$BR" ! -s "$SUBNET" -j DROP
  echo "なりすまし対策を適用しました (ブリッジ: $BR)"
else
  echo "警告: devbox-net のブリッジが見つかりません。docker compose up のあとに、もう一度実行してください" >&2
fi

echo "適用しました。確認:"
echo "  docker run --rm --network devbox-net alpine ping -c1 -W2 <社内LANのIP>   # → 失敗すること"
echo "  docker run --rm --network devbox-net alpine wget -qO- -T5 https://example.com | head -c100   # → 成功すること"
echo "  docker run --rm --network devbox-net alpine nc -zv -w3 <このVMのIP> 22   # → 失敗(timeout)すること"
echo "  iptables -S DOCKER-USER | grep -- '! -s $SUBNET'   # → なりすまし対策のルールが1行あること"
