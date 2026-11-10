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
#   3. Listener code changes go through /usr/local/bin/auxgoat-update and
#      nothing else. That is the one thing allowed to change the package, and
#      it earns it: staging gates, a trial, and an automatic way back. This
#      script holds a SHARED lock for its whole run and the updater takes the
#      same lock EXCLUSIVELY, so the two can never be mid-flight together -
#      the guard below would otherwise "restore" a release that was being
#      installed on purpose.
#
# THE PACKAGE PATH MAY BE A SYMLINK NOW. After the first over-the-air update
# /opt/lockerroom/lockerroom points into /opt/lockerroom/releases/<id>/. The
# guard resolves it first and protects BOTH things a repair could damage: the
# files inside the release, and which release the link points at. (The
# original guard ran `find` on the link itself, which finds nothing - so on an
# updated box it would have verified an empty list against an empty list.)
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
RUN_DIR="${AUXGOAT_RUN:-/run/lockerroom}"
REPAIR_REL="pi/scripts/remote-repair.sh"
SNAPSHOT=""
trap '[ -n "$SNAPSHOT" ] && rm -rf "$SNAPSHOT"' EXIT

echo "AuxGoat repair run"
echo "collected: $(date -Is 2>/dev/null || date 2>/dev/null)"
echo

# --------------------------------------------------------------------------
# 0. Never overlap an over-the-air update.
#
# Shared here, exclusive in auxgoat-update. Twenty seconds is plenty: the
# updater holds it only while it stages and switches, not for the whole trial.
# A box without flock (it is util-linux, so that would be a strange box) just
# runs unlocked, as this script always used to.
# --------------------------------------------------------------------------
mkdir -p "$RUN_DIR" 2>/dev/null
if command -v flock >/dev/null 2>&1 && exec 9>"$RUN_DIR/update.lock"; then
  if ! flock -s -w 20 9; then
    echo "An over-the-air update is switching the listener right now, so this"
    echo "repair did not run. Nothing was changed. Try again in a minute."
    exit 1
  fi
fi

# --------------------------------------------------------------------------
# 1. Snapshot the listener package.
# --------------------------------------------------------------------------
manifest() {
  # Sorted checksums of every file. Content, not mtime: a deploy that rewrites
  # a file with identical bytes is not a modification worth restoring over.
  find "$1" -type f ! -name '*.pyc' ! -path '*__pycache__*' -print0 2>/dev/null \
    | sort -z | xargs -0 sha256sum 2>/dev/null | sed "s#$1/##"
}

# Where the files really are, and what the link (if it is one) says.
REAL="$(readlink -f "$PKG" 2>/dev/null)"
LINK_BEFORE="$(readlink "$PKG" 2>/dev/null)"
SNAP_OK=0
if [ -n "$REAL" ] && [ -d "$REAL" ]; then
  BEFORE="$(manifest "$REAL")"
  # BESIDE the package, not in /tmp. /tmp is a RAM disk on this OS and can be
  # full, and a restore from the same filesystem is a rename rather than a
  # copy that a power cut can leave half done.
  SNAPSHOT="$(mktemp -d "$(dirname "$REAL")/.pkg-snapshot.XXXXXX" 2>/dev/null)" || SNAPSHOT=""
  if [ -n "$SNAPSHOT" ] && cp -a "$REAL/." "$SNAPSHOT/" 2>/dev/null \
     && [ "$(manifest "$SNAPSHOT")" = "$BEFORE" ]; then
    SNAP_OK=1
    echo "listener package snapshotted: $(echo "$BEFORE" | wc -l | tr -d ' ') files"
  else
    # Say so NOW. A snapshot that silently came out short is how a "restore"
    # turns into deleting the listener.
    echo "WARNING: could not take a complete snapshot of the listener package."
    echo "         The repair still runs, but a change to the package could only"
    echo "         be REPORTED, not undone."
  fi
  [ -n "$LINK_BEFORE" ] && echo "package is release: $LINK_BEFORE"
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
UPSTREAM=""
if [ -d "$REPO/.git" ]; then
  # Git runs as whoever owns the clone, because that is whose SSH key can reach
  # GitHub. Running it as root would look in /root/.ssh and fail on a box that
  # was provisioned correctly.
  OWNER="$(stat -c '%U' "$REPO" 2>/dev/null || echo root)"
  echo "repo:  $REPO (owner: $OWNER)"
  echo "was:   $(timeout 10 sudo -u "$OWNER" git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
  if timeout 45 sudo -u "$OWNER" git -C "$REPO" fetch --quiet --all 2>&1; then
    UPSTREAM="$(timeout 10 sudo -u "$OWNER" git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"
    if [ -n "$UPSTREAM" ] && timeout 20 sudo -u "$OWNER" git -C "$REPO" reset --hard "$UPSTREAM" 2>&1; then
      PULL_OK=1
    else
      echo "ERROR: could not reset to upstream (${UPSTREAM:-none configured})"
    fi
  else
    echo "ERROR: fetch failed. On campus this needs 443 to ssh.github.com —"
    echo "       port 22 is filtered. Check the remote URL and the deploy key."
  fi
  echo "now:   $(timeout 10 sudo -u "$OWNER" git -C "$REPO" rev-parse --short HEAD 2>/dev/null) on ${UPSTREAM:-?}"
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
  # Bounded, and the budgets add up: 10+45+10+20+10 for the pull, 110 here,
  # and the guard, inside the 240s the listener gives this command. A repair
  # that hangs must not hold the control channel open for ever.
  #
  # 9>&- so nothing the repair starts can inherit the update lock. A stray
  # background process holding it would block every later update.
  timeout 110 bash "$REPAIR" 2>&1 9>&-
  RC=$?
  [ "$RC" = "124" ] && echo "(repair timed out after 110s)"
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
package_intact() {
  [ "$(readlink -f "$PKG" 2>/dev/null)" = "$REAL" ] \
    && [ "$(readlink "$PKG" 2>/dev/null)" = "$LINK_BEFORE" ] \
    && [ "$(manifest "$REAL")" = "$BEFORE" ]
}

if [ -z "$REAL" ]; then
  echo "(no package directory to verify)"
elif package_intact; then
  echo "VERIFIED: the listener package is byte-for-byte unchanged."
else
  echo "!! THE REPAIR MODIFIED THE LISTENER PACKAGE. Restoring it."
  echo "   The listener is the control channel. A repair that can replace it"
  echo "   can lock everyone out of the box while using it, so it is not"
  echo "   allowed to — and the snapshot taken before the run is going back."
  echo
  echo "   changed:"
  diff <(echo "$BEFORE") <(manifest "$REAL") 2>/dev/null | sed 's/^/     /' | head -n 40
  [ "$(readlink "$PKG" 2>/dev/null)" = "$LINK_BEFORE" ] \
    || echo "     the package path itself: was '${LINK_BEFORE:-a directory}', now '$(readlink "$PKG" 2>/dev/null || echo "a directory or missing")'"

  if [ "$SNAP_OK" = "1" ]; then
    # 4a. The files. Build the restored copy NEXT to the package and swap it
    #     in by rename, so there is no moment with half a package.
    if [ "$(manifest "$REAL")" != "$BEFORE" ]; then
      FRESH="$REAL.restore.$$"
      rm -rf "$FRESH"
      if cp -a "$SNAPSHOT" "$FRESH" 2>/dev/null && [ "$(manifest "$FRESH")" = "$BEFORE" ]; then
        if [ -e "$REAL" ] || [ -L "$REAL" ]; then mv "$REAL" "$REAL.modified.$$"; fi
        mv "$FRESH" "$REAL"
        rm -rf "$REAL.modified.$$"
      else
        rm -rf "$FRESH"
        echo "   could not rebuild the package from the snapshot"
      fi
    fi
    # 4b. The link. Put it back with a rename, which is atomic.
    if [ -n "$LINK_BEFORE" ] && [ "$(readlink "$PKG" 2>/dev/null)" != "$LINK_BEFORE" ]; then
      if [ -e "$PKG" ] && [ ! -L "$PKG" ]; then mv "$PKG" "$PKG.modified.$$"; fi
      ln -s "$LINK_BEFORE" "$PKG.guard.$$" && mv -T "$PKG.guard.$$" "$PKG"
      rm -rf "$PKG.modified.$$"
    fi
  fi

  if package_intact; then
    echo "   RESTORED. Restarting the listener onto the original code."
    timeout 60 systemctl restart lockerroom-listener 2>&1
  else
    echo "   !! RESTORE FAILED. The box may be running modified listener code."
    [ "$SNAP_OK" = "1" ] || echo "      (there was no complete snapshot to restore from)"
    echo "      This needs a shell — serial console or the USB-C cable."
  fi
  RC=1
fi

echo
echo "===== END OF REPAIR RUN ====="
exit "$RC"
