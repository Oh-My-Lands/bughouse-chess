#!/usr/bin/env bash
# Deploy the bughouse analysis viewer to the production server: build the Next.js
# standalone bundle locally, sync it to the server, then restart the service.
# Run from anywhere; paths resolve to this repo.
#
#   ./deploy.sh                                   # deploy to the default server
#   ANALYSIS_SERVER=root@1.2.3.4 ./deploy.sh      # deploy elsewhere
#
# This deploys the APP only. The RunPod credentials live on the server at
# /opt/analysis/env (see deploy/README.md) and are never shipped from here.
#
# The build is done locally on purpose: a Next production build peaks well over
# 1 GB of RAM, and the box is a 4 GB instance already running the explorer's
# database. The server only needs the Node runtime, not the build toolchain.
set -euo pipefail

SERVER="${ANALYSIS_SERVER:-root@138.199.195.186}"
APP_DIR="/opt/analysis/app"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# These are baked into the client bundle at build time (that is what the
# NEXT_PUBLIC_ prefix means), so they must be set now, not on the server.
#   SITE_URL      -> canonical/OG URLs
#   ENGINE_ENDPOINT -> the client posts to the same-origin proxy at /api/engine
export NEXT_PUBLIC_SITE_URL="https://analysis.josephw.me"
export NEXT_PUBLIC_ENGINE_ENDPOINT="/api/engine"

# node may be installed under ~/.local/node rather than on PATH.
if ! command -v npm >/dev/null 2>&1 && [[ -x "$HOME/.local/node/bin/npm" ]]; then
  export PATH="$HOME/.local/node/bin:$PATH"
fi

echo "==> Building standalone bundle (NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL)"
( cd "$REPO" && npm run build )

# The standalone output does not include the client assets or public/ files;
# Next expects them copied in alongside server.js.
echo "==> Assembling standalone bundle"
cp -r "$REPO/.next/static" "$REPO/.next/standalone/.next/static"
if [[ -d "$REPO/public" ]]; then
  cp -r "$REPO/public" "$REPO/.next/standalone/public"
fi

echo "==> Syncing bundle to $SERVER:$APP_DIR"
# --delete keeps the server a clean mirror of the fresh build. The RunPod env
# file lives one level up at /opt/analysis/env, so it is never touched.
rsync -a --delete "$REPO/.next/standalone/" "$SERVER:$APP_DIR/"

echo "==> Fixing ownership and restarting service"
ssh "$SERVER" '
  chown -R analysis:analysis /opt/analysis/app &&
  systemctl restart analysis-viewer &&
  sleep 2 &&
  systemctl is-active analysis-viewer
'

echo "==> Deployed. https://analysis.josephw.me"
