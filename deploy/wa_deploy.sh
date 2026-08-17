#!/usr/bin/env bash
# Deploy wa-webhook on byteplus-prod-app. Copy to ~/wa_deploy.sh, chmod 700.
#
# Deliberately its own script. ~/backend_deploy.sh restarts the live mobile API
# and ~/dashboard_deploy.sh rebuilds the nutrition dashboard; neither may ever
# touch this app, and this must never touch them.
set -euo pipefail

APP_DIR="/opt/wa-webhook"
BRANCH="${1:-main}"

cd "$APP_DIR"

echo "==> fetching origin/$BRANCH"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "==> installing production dependencies"
# --omit=dev drops playwright. Scripts must RUN: ffmpeg-static sets its own exec
# bit in a postinstall, and without it transcode.isAvailable() is false and
# every voice note returns 502. Set FFMPEG_BIN instead to skip the 83MB download.
npm ci --omit=dev

echo "==> reloading"
# reload, never restart: a restart drops in-flight webhook requests, and Meta
# does not redeliver what it already saw answered.
pm2 reload wa-webhook --update-env

pm2 save

echo "==> health"
sleep 2
curl -fsS http://127.0.0.1:8080/api/session && echo
echo "==> done"
