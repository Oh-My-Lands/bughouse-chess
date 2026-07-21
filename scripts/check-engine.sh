#!/usr/bin/env bash
# Check that the RunPod serverless endpoint is configured and answering.
#
#   npm run check:engine
#
# Deliberately NOT wired into `npm run dev`. Working on the UI does not need a
# working engine, so a failing endpoint must not stop the app from starting.
# Run this when analysis misbehaves — which is the only time the answer matters.
#
# It exists because the two ways this configuration goes stale both surface at
# request time as a generic failed search, and neither names its own cause:
#
#   404  the endpoint id is gone. Endpoints are not renamed, they are recreated
#        with a new id, so an id that worked last week can simply cease to exist.
#   401  the key is not valid *for this endpoint*. A job-scoped key only
#        authenticates against the endpoint it was issued for, so a stale key
#        and a stale id look identical from the app's side.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.local}"

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
info() { printf '  ..    %s\n' "$1"; }
die()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }

# Reads one key without sourcing or exporting it: these are secrets, and only
# the Next process has any business holding them.
env_value() {
  sed -nE "s/^$1=[[:space:]]*\"?([^\"]*)\"?[[:space:]]*$/\1/p" "$ENV_FILE" 2>/dev/null | tail -n 1
}

[ -f "$ENV_FILE" ] || die "no $ENV_FILE — needs RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY"

ID="$(env_value RUNPOD_ENDPOINT_ID)"
KEY="$(env_value RUNPOD_API_KEY)"
EP="$(env_value NEXT_PUBLIC_ENGINE_ENDPOINT)"

[ -n "$ID" ]  || die "RUNPOD_ENDPOINT_ID is unset in $ENV_FILE"
[ -n "$KEY" ] || die "RUNPOD_API_KEY is unset in $ENV_FILE"

# NEXT_PUBLIC_* is substituted into the bundle at compile time rather than read
# at runtime, so a wrong value here is baked into .next and survives editing
# this file. Changing it means clearing .next as well.
[ "$EP" = "/api/engine" ] \
  || die "NEXT_PUBLIC_ENGINE_ENDPOINT should be /api/engine, got '${EP:-unset}' (and clear .next after changing it)"

info "checking endpoint $ID"
code="$(curl -s -o /tmp/check-engine.$$ -w '%{http_code}' --max-time 20 \
  -H "Authorization: Bearer $KEY" \
  "https://api.runpod.ai/v2/$ID/health" 2>/dev/null)"

case "$code" in
  200)
    ok "endpoint healthy"
    command -v python3 >/dev/null && python3 -c "
import json,sys
d=json.load(open('/tmp/check-engine.$$'))
w=d.get('workers',{}); j=d.get('jobs',{})
print('        workers: ' + ', '.join(f'{k}={v}' for k,v in w.items() if v))
print('        jobs:    completed={} failed={} inQueue={}'.format(
    j.get('completed',0), j.get('failed',0), j.get('inQueue',0)))
" 2>/dev/null
    rm -f "/tmp/check-engine.$$"
    ;;
  404) rm -f "/tmp/check-engine.$$"; die "endpoint $ID does not exist (404) — deleted, or recreated with a new id" ;;
  401) rm -f "/tmp/check-engine.$$"; die "key rejected by $ID (401) — a job-scoped key only works on its own endpoint" ;;
  *)   rm -f "/tmp/check-engine.$$"; die "health check returned HTTP ${code:-no response}" ;;
esac
