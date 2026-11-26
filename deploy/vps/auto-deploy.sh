#!/bin/sh
# Auto-deploy for the website. Run once as root on the server:
#   curl -sL https://raw.githubusercontent.com/GMEchain/GME-Chain/main/deploy/vps/auto-deploy.sh | sh
# Every 2 minutes the server pulls this repository and publishes site/ when main has moved. The wallet bundle is
# built outside git, so the sync never deletes it. To turn it off: rm /etc/cron.d/gmechain-pull
set -e

command -v git >/dev/null || apt-get install -y -q git
command -v rsync >/dev/null || apt-get install -y -q rsync
[ -d /opt/gmechain-src/.git ] || git clone -q https://github.com/GMEchain/GME-Chain.git /opt/gmechain-src

cat > /usr/local/bin/gmechain-pull <<'PULL'
#!/bin/sh
set -e
cd /opt/gmechain-src
git fetch -q origin main
[ "$1" != "--force" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
git reset -q --hard origin/main
rsync -a --delete --exclude 'js/walletkit/' --exclude 'walletkit.css' site/ /opt/gmechain/site/
logger -t gmechain-pull "site updated to $(git rev-parse --short HEAD)"
PULL
chmod 755 /usr/local/bin/gmechain-pull

echo '*/2 * * * * root /usr/local/bin/gmechain-pull' > /etc/cron.d/gmechain-pull
chmod 644 /etc/cron.d/gmechain-pull

/usr/local/bin/gmechain-pull --force
echo "auto-deploy is on: site at $(cd /opt/gmechain-src && git rev-parse --short HEAD), checked every 2 minutes"
