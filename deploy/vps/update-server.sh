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
cp $SRC/deploy/vps/Dockerfile.scripts Dockerfile.scripts # the image of every chain service
if ! docker run --rm -v "$PWD/Caddyfile.internal:/etc/caddy/Caddyfile:ro" caddy:2.8.4-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  tail -5 /tmp/caddy-validate.log; cp "$B/Caddyfile.internal" "$B/docker-compose.coolify.yml" .; echo "CADDYFILE INVALID, restored the old one"; exit 1
fi
docker compose -f docker-compose.coolify.yml --profile chain --profile testnet up -d web nitro nitro-testnet 2>&1 | tail -6

# chain scripts (public code) and the public deployment records; keys stay in secrets/ and nodeConfig files
cp -a $APP/chain/scripts "$B"/chain-scripts
rsync -a $SRC/chain/scripts/ $APP/chain/scripts/
cp $SRC/chain/package.json $SRC/chain/package-lock.json $SRC/chain/deployment.mainnet.json $SRC/chain/deployment.testnet.json $APP/chain/

# withdrawal delivery wallets: generated here once, the key never leaves this server
DC="docker compose -f docker-compose.coolify.yml --profile chain --profile testnet"
$DC build -q keeper
# the services run as the image's "node" user (uid 1000): their data volumes must belong to it
for v in gmechain_media_data gmechain_credits_data; do docker volume create "$v" >/dev/null; docker run --rm -v "$v":/d alpine:3.20 chown -R 1000:1000 /d; done
newkey() { # $1 = env file, $2 = file to copy PARENT_RPC from, $3 = variable prefix (default CLAIMER)
  [ -s "secrets/$1" ] && return 0
  P=${3:-CLAIMER}
  K="0x$(openssl rand -hex 32)"
  A=$($DC run --rm --no-deps -e K="$K" --entrypoint node keeper -e "import('viem/accounts').then((m) => console.log(m.privateKeyToAccount(process.env.K).address))" | tail -1)
  case "$A" in 0x*) ;; *) echo "could not derive the address for $1"; return 1 ;; esac
  ( umask 077; { echo "${P}_PRIVATE_KEY=$K"; echo "${P}_ADDRESS=$A"; grep '^PARENT_RPC=' "secrets/$2" 2>/dev/null || true; } > "secrets/$1" )
  echo "created secrets/$1 for $A"
}
newkey claimer.env keeper.env
newkey claimer-testnet.env pulse.env
newkey credits.env keeper.env REDEEMER
# the credits service needs the staking contract in the deployment record; until then only media starts
if grep -q '"gmecStaking"' $APP/chain/deployment.mainnet.json; then EXTRA="credits media"; else EXTRA="media"; fi
$DC up -d --build keeper monitor claimer pulse faucet claimer-testnet $EXTRA 2>&1 | tail -8
sleep 30
echo "--- withdrawal delivery wallets (send a little ETH on Robinhood Chain to each; testnet ETH for the testnet one)"
echo "mainnet: $(grep '^CLAIMER_ADDRESS=' secrets/claimer.env | cut -d= -f2)"
echo "testnet: $(grep '^CLAIMER_ADDRESS=' secrets/claimer-testnet.env | cut -d= -f2)"
docker logs --tail 2 gmechain-claimer-1 2>&1 | cut -c1-200
docker logs --tail 2 gmechain-claimer-testnet-1 2>&1 | cut -c1-200
echo "--- gas credits wallet (staking redeemer; use it for scripts/09-credits-setup.js): $(grep '^REDEEMER_ADDRESS=' secrets/credits.env | cut -d= -f2)"
printf 'media -> '; curl -s -m 10 https://gmechain.xyz/media/health; echo
printf 'credits -> '; curl -s -m 10 https://gmechain.xyz/api/credits/info; echo

echo "--- check"
docker ps --format '{{.Names}} {{.Status}}' | grep gmechain
curl -sI https://gmechain.xyz/ | grep -qi "content-security-policy" && echo "CSP: on" || echo "CSP: MISSING"
for u in https://rpc.gmechain.xyz https://rpc.testnet.gmechain.xyz; do
  printf '%s -> ' "$u"; curl -s -m 10 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$u"; echo
done
echo "DONE"
