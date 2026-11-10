#!/usr/bin/env bash
# Deploy the team Worker BY HAND, safely. (Merging to main deploys it too, via
# .github/workflows/deploy-worker.yml - this is for a laptop.)
#
# Use this, never a bare `npx wrangler deploy`. Wrangler CREATES a Worker when
# none has the name in wrangler.toml, and a new Worker has no secrets: it
# would take the custom domains and answer every request with an error, and
# MAC_SALT cannot be read back out of Cloudflare to repair it.
#
# The Worker was renamed on 2026-11-10 and the rename is finished in the
# Cloudflare dashboard (see docs/LAUNCH.md). Until that has been done this
# uploads to the Worker that actually exists, under its old name.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NAME="$(sed -n 's/^name = "\(.*\)"$/\1/p' wrangler.toml | head -n 1)"
LEGACY="locker-room-music"
if [ -z "$NAME" ]; then
  echo "Could not read the Worker name from wrangler.toml." >&2
  exit 1
fi

# `deployments list` fails for a Worker that does not exist (and when wrangler
# is not logged in, which stops here too - the safe direction).
if npx wrangler deployments list --name "$NAME" >/dev/null 2>&1; then
  TARGET="$NAME"
elif npx wrangler deployments list --name "$LEGACY" >/dev/null 2>&1; then
  TARGET="$LEGACY"
  echo "NOTE: the Worker is still named '$LEGACY'. Deploying to it."
  echo "      Rename it to '$NAME' in the Cloudflare dashboard to finish - docs/LAUNCH.md."
else
  echo "REFUSING TO DEPLOY: found no Worker named '$NAME' or '$LEGACY'." >&2
  echo "Either wrangler is not logged in (npx wrangler login), or the Worker" >&2
  echo "really does not exist - and creating one here would make it without" >&2
  echo "secrets. For a genuine first deploy: npx wrangler deploy --name $NAME" >&2
  exit 1
fi

find public -name '.DS_Store' -delete 2>/dev/null || true
exec npx wrangler deploy --name "$TARGET"
