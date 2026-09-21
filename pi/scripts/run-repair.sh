#!/usr/bin/env bash
# The escape hatch: pull the repo and run the committed repair script.
#
# This is the "FIX anything" half of the 443 beacon. On campus there is no
# other way in — 7844 is blocked both protocols so Cloudflare Tunnel cannot
# run, Tailscale is blocked by SNI, and TCP/22 is filtered between guest
# clients and outbound — so without this, a box whose Bluetooth units have
# stopped is a box nobody can fix until they are standing next to it.
#
# WHERE THE PARAMETER WENT. This takes no arguments, like every other entry on
# the allowlist, and that is not a technicality. The thing being varied is the
# COMMIT YOU PUSHED: write the fix into pi/scripts/remote-repair.sh, commit,
# push, then press the button. The allowlist still maps a fixed name to a fixed
# argv on both ends, and there is still no "run this string" command.
#
# ============================================================================
# THE HARD CONSTRAINT: THIS MUST NEVER MODIFY THE LISTENER PACKAGE.
# ============================================================================
# The listener IS this control channel. A mechanism that can replace it can
# destroy remote access while it is being used — one bad commit and the box is
# unreachable with no way to take the commit back. So:
#
#   1. This script never copies anything into /opt/lockerroom/lockerroom. The
#      repo is pulled to a SEPARATE path and only the repair script is run.
#   2. The package is snapshotted before the repair runs and verified after. If
#      the repair modified it anyway, the snapshot is RESTORED and the listener
#      restarted — enforcement, not just a warning.
#   3. Listener code changes still require a shell. That is deliberate. Repair
#      scripts are the only thing this can change, and that limit is the reason
#      it is safe to hand a button on a web page the ability to run it.
set -uo pipefail   # not -e: every step reports and continues, because a report
                   # that stops at the first problem is the failure this whole
                   # feature exists to stop repeating.

# Overridable ONLY so the integrity guard at the end can be tested against a
# throwaway directory - see pi/tests/test_run_repair_guard.py. Nothing can set
# these in production: the listener invokes this as a fixed argv from the
# command allowlist, with no attacker-controlled environment in front of it.
# A guarantee nobody has exercised is a guarantee nobody should rely on.
REPO="${LOCKERROOM_REPO:-/opt/lockerroom/repo}"
PKG="${LOCKERROOM_PKG:-/opt/lockerroom/lockerroom}"
REPAIR_REL="pi/scripts/remote-repair.sh"
SNAPSHOT="$(mktemp -d /tmp/lockerroom-pkg-snapshot.XXXXXX)"
trap 'rm -rf "$SNAPSHOT"' EXIT

echo "AuxGoat repair run"
echo "collected: $(date -Is 2>/dev/null || date 2>/dev/null)"
echo

# --------------------------------------------------------------------------
# 1. Snapshot the listener package.
# --------------------------------------------------------------------------
manifest() {
  # Sorted checksums of every file. Content, not mtime: a deploy that rewrites
  # a file with identical bytes is not a modification worth restoring over.
  find "$1" -type f ! -name '*.pyc' ! -path '*__pycache__*' -print0 2>/dev/null \
    | sort -z | xargs -0 sha256sum 2>/dev/null | sed "s#$1/##"
}

if [ -d "$PKG" ]; then
  cp -a "$PKG/." "$SNAPSHOT/" 2>/dev/null
  BEFORE="$(manifest "$PKG")"
  echo "listener package snapshotted: $(echo "$BEFORE" | wc -l | tr -d ' ') files"
else
  BEFORE=""
  echo "WARNING: $PKG does not exist. Nothing to protect, which is itself odd."
fi
echo

# --------------------------------------------------------------------------
# 2. Pull the repo.
# --------------------------------------------------------------------------
echo "===== PULL ====="
PULL_OK=0
if [ -d "$REPO/.git" ]; then
  # Git runs as whoever owns the clone, because that is whose SSH key can reach
  # GitHub. Running it as root would look in /root/.ssh and fail on a box that
  # was provisioned correctly.
  OWNER="$(stat -c '%U' "$REPO" 2>/dev/null || echo root)"
  echo "repo:  $REPO (owner: $OWNER)"
  echo "was:   $(sudo -u "$OWNER" git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
  if timeout 60 sudo -u "$OWNER" git -C "$REPO" fetch --quiet --all 2>&1; then
    UPSTREAM="$(sudo -u "$OWNER" git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"
    if [ -n "$UPSTREAM" ] && timeout 30 sudo -u "$OWNER" git -C "$REPO" reset --hard "$UPSTREAM" 2>&1; then
      PULL_OK=1
    else
      echo "ERROR: could not reset to upstream (${UPSTREAM:-none configured})"
    fi
  else
    echo "ERROR: fetch failed. On campus this needs 443 to ssh.github.com —"
    echo "       port 22 is filtered. Check the remote URL and the deploy key."
  fi
  echo "now:   $(sudo -u "$OWNER" git -C "$REPO" rev-parse --short HEAD 2>/dev/null) on ${UPSTREAM:-?}"
else
  echo "ERROR: no git clone at $REPO."
  echo "       Provision it with:  sudo git clone <url> $REPO"
  echo "       Until then this can only run the script already on disk."
fi

if [ "$PULL_OK" != "1" ]; then
  # Deliberately NOT fatal. The job of this button is to fix a box that is
  # already partly broken; refusing to run the last-known-good repair script
  # because the network is also unwell would make it useless at exactly the
  # moment it is needed. It runs, and it says loudly that it ran stale code.
  echo
  echo "!! RUNNING WITHOUT A SUCCESSFUL PULL. The script below is whatever was"
  echo "   last on disk, NOT necessarily what you just pushed. Check the commit"
  echo "   printed above before believing the result."
fi
echo

# --------------------------------------------------------------------------
# 3. Run the repair script.
# --------------------------------------------------------------------------
echo "===== REPAIR ($REPAIR_REL) ====="
REPAIR="$REPO/$REPAIR_REL"
RC=0
if [ -f "$REPAIR" ]; then
  # Bounded. A repair that hangs must not hold the control channel open
  # forever; the Python side gives this command a matching budget.
  timeout 120 bash "$REPAIR" 2>&1
  RC=$?
  [ "$RC" = "124" ] && echo "(repair timed out after 120s)"
else
  echo "ERROR: $REPAIR is missing. Commit a repair script at that exact path."
  RC=1
fi
echo
echo "repair exit: $RC"
echo

# --------------------------------------------------------------------------
# 4. Verify the listener package is untouched — and put it back if it is not.
# --------------------------------------------------------------------------
echo "===== LISTENER PACKAGE INTEGRITY ====="
if [ -d "$PKG" ]; then
  AFTER="$(manifest "$PKG")"
  if [ "$BEFORE" = "$AFTER" ]; then
    echo "VERIFIED: the listener package is byte-for-byte unchanged."
  else
    echo "!! THE REPAIR MODIFIED THE LISTENER PACKAGE. Restoring it."
    echo "   The listener is the control channel. A repair that can replace it"
    echo "   can lock everyone out of the box while using it, so it is not"
    echo "   allowed to — and the snapshot taken before the run is going back."
    echo
    echo "   changed:"
    diff <(echo "$BEFORE") <(echo "$AFTER") 2>/dev/null | sed 's/^/     /' | head -n 40
    rm -rf "$PKG"
    mkdir -p "$PKG"
    cp -a "$SNAPSHOT/." "$PKG/" 2>/dev/null
    if [ "$(manifest "$PKG")" = "$BEFORE" ]; then
      echo "   RESTORED. Restarting the listener onto the original code."
      systemctl restart lockerroom-listener 2>&1
    else
      echo "   !! RESTORE FAILED. The box may be running modified listener code."
      echo "      This needs a shell — serial console or the USB-C cable."
    fi
    RC=1
  fi
else
  echo "(no package directory to verify)"
fi

echo
echo "===== END OF REPAIR RUN ====="
exit "$RC"
