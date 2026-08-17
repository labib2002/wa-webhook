#!/usr/bin/env bash
# Deploy wa-webhook on byteplus-prod-app. Copy to ~/wa_deploy.sh, chmod 700.
#
# Deliberately its own script. ~/backend_deploy.sh restarts the live mobile API
# and ~/dashboard_deploy.sh rebuilds the nutrition dashboard; neither may ever
# touch this app, and this must never touch them.
#
# The app runs as its own OS user out of /opt/wa-webhook, which is NOT a git
# checkout: the secrets there must not be readable by ubuntu. Git lives in a
# separate clone that ubuntu owns, and the release is synced across.
set -euo pipefail

SRC_DIR="/home/ubuntu/wa-webhook-src"
APP_DIR="/opt/wa-webhook"
APP_USER="wa-webhook"
BRANCH="${1:-main}"

export PM2_HOME="$APP_DIR/.pm2"

echo "==> fetching origin/$BRANCH"
git -C "$SRC_DIR" fetch origin "$BRANCH"
git -C "$SRC_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
echo "    $(git -C "$SRC_DIR" log --oneline -1)"

echo "==> syncing release into $APP_DIR"
# .env holds the only copy of the secrets and node_modules is built in place;
# neither is in git, so both must survive the sync.
sudo rsync -a --delete \
  --exclude '.git' --exclude '.env' --exclude 'node_modules' \
  --exclude '.pm2' --exclude '.cache' --exclude '.npm' \
  --chown="$APP_USER:$APP_USER" \
  "$SRC_DIR"/ "$APP_DIR"/

echo "==> installing production dependencies"
# --omit=dev drops playwright. Scripts must RUN: ffmpeg-static sets its own exec
# bit in a postinstall, and without it transcode.isAvailable() is false and
# every voice note returns 502. Set FFMPEG_BIN instead to skip the 83MB download.
# cd /tmp first: sudo keeps the caller's cwd, and ubuntu's home is 0750 to us.
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --omit=dev"

echo "==> reloading"
# reload, never restart: a restart drops in-flight webhook requests, and Meta
# does not redeliver what it already saw answered.
sudo -u "$APP_USER" bash -lc "cd /tmp && PM2_HOME='$PM2_HOME' pm2 reload wa-webhook --update-env"
sudo -u "$APP_USER" bash -lc "cd /tmp && PM2_HOME='$PM2_HOME' pm2 save"

echo "==> health"
sleep 2
curl -fsS http://127.0.0.1:8080/api/session && echo
echo "==> done"
