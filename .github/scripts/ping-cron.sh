#!/usr/bin/env bash
# Curl a /api/cron/* endpoint with the bearer secret. APP_URL + CRON_SECRET
# come from the workflow env. The 60-second timeout fits LLM-publish
# prophesy crons (~17s typical) plus generous headroom; settle + sweep
# finish in <3s and are nowhere near it.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: ping-cron.sh <path>" >&2
  exit 2
fi

path="$1"
curl -fsS \
  --max-time 60 \
  --retry 2 --retry-delay 5 \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${APP_URL}${path}" \
  -o /tmp/out.json -w "HTTP %{http_code} in %{time_total}s\n"
head -c 2000 /tmp/out.json
echo
