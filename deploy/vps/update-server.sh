#!/bin/sh
# Brings the server in line with this repository, without SSH from a laptop. Run as root on the server
# (for example from the Hostinger Web console):
#   curl -sL https://raw.githubusercontent.com/GMEchain/GME-Chain/main/deploy/vps/update-server.sh | sh
# It publishes site/, builds the wallet bundle, and applies the Caddy and Traefik settings (CSP, RPC rate limit).
# Everything it replaces is backed up first; a Caddyfile that does not validate is put back and nothing restarts.
set -e
SRC=/opt/gmechain-src
APP=/opt/gmechain
[ -x /usr/local/bin/gmechain-pull ] || { echo "auto-deploy is not installed: run deploy/vps/auto-deploy.sh first"; exit 1; }

/usr/local/bin/gmechain-pull --force
echo "site at $(cd $SRC && git rev-parse --short HEAD)"

B=/opt/gmechain-backups/$(date +%Y%m%d-%H%M%S); mkdir -p "$B"
cp -a $APP/deploy/vps/Caddyfile.internal $APP/deploy/vps/docker-compose.coolify.yml "$B"/
[ -d $APP/site/js/walletkit ] && cp -a $APP/site/js/walletkit $APP/site/walletkit.css "$B"/ 2>/dev/null || true
echo "backup $B"

# wallet bundle (RainbowKit + viem): built in a throwaway Node container, never committed to git
docker run --rm -v $SRC:/w -w /w/walletkit node:22-alpine sh -c "npm ci --no-audit --no-fund --loglevel=error && npm run build --silent" >/tmp/walletkit-build.log 2>&1 || { tail -20 /tmp/walletkit-build.log; echo "WALLET BUILD FAILED, site unchanged"; exit 1; }
rsync -a --delete $SRC/site/js/walletkit/ $APP/site/js/walletkit/
cp $SRC/site/walletkit.css $APP/site/walletkit.css
echo "wallet bundle: $(ls $APP/site/js/walletkit | wc -l) files, viem.js $(test -f $APP/site/js/walletkit/viem.js && echo yes || echo NO)"

# Caddy (headers, CSP) and Traefik labels (RPC rate limit)
cd $APP/deploy/vps
cp $SRC/deploy/vps/Caddyfile.internal Caddyfile.internal
cp $SRC/deploy/vps/docker-compose.coolify.yml docker-compose.coolify.yml
if ! docker run --rm -v "$PWD/Caddyfile.internal:/etc/caddy/Caddyfile:ro" caddy:2.8.4-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  tail -5 /tmp/caddy-validate.log; cp "$B/Caddyfile.internal" "$B/docker-compose.coolify.yml" .; echo "CADDYFILE INVALID, restored the old one"; exit 1
fi
docker compose -f docker-compose.coolify.yml --profile chain --profile testnet up -d web nitro nitro-testnet 2>&1 | tail -6
sleep 30

echo "--- check"
docker ps --format '{{.Names}} {{.Status}}' | grep gmechain
curl -sI https://gmechain.xyz/ | grep -qi "content-security-policy" && echo "CSP: on" || echo "CSP: MISSING"
for u in https://rpc.gmechain.xyz https://rpc.testnet.gmechain.xyz; do
  printf '%s -> ' "$u"; curl -s -m 10 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$u"; echo
done
echo "DONE"
