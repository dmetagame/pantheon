#!/usr/bin/env bash
# Curl a /api/cron/* endpoint with the bearer secret. APP_URL + CRON_SECRET
# come from the workflow env.
#
# Timeout budget: settle walks a 4-step on-chain pipeline (propose → approve
# → settle → reputation) where each step waits up to 120s for tx finalization
# on Casper testnet. Worst-case wall time is ~4 minutes when the network is
# slow. maxDuration=300s on the Vercel route caps it; we sit just under that.
#
# Retries are disabled — the settle pipeline persists after each step so
# whatever partial work happened during a client-side abort resumes cleanly
# on the next cron tick.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: ping-cron.sh <path>" >&2
  exit 2
fi

path="$1"
curl -fsS \
  --max-time 290 \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${APP_URL}${path}" \
  -o /tmp/out.json -w "HTTP %{http_code} in %{time_total}s\n"
head -c 2000 /tmp/out.json
echo
