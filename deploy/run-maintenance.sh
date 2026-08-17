#!/usr/bin/env bash
# Daily maintenance trigger. Copy to /opt/wa-webhook/run-maintenance.sh,
# chmod 700, owned by the wa-webhook service user.
#
# crontab entry (CRON_TZ is load-bearing: Vercel's cron ran in UTC, a box
# crontab inherits the box timezone, and this account already pins an AWS
# Backup plan to Africa/Cairo):
#
#   CRON_TZ=UTC
#   0 3 * * * /opt/wa-webhook/run-maintenance.sh >> /var/log/wa-maintenance.log 2>&1
#
# Hits 127.0.0.1 directly, so neither the ALB's 60s idle timeout nor Vercel's
# old 60s maxDuration applies to the retention pass.
set -euo pipefail

set -a
. /opt/wa-webhook/.env
set +a

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) maintenance start ==="
curl -fsS -m 600 \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  http://127.0.0.1:8080/api/cron/maintenance
echo
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) maintenance end ==="
