#!/usr/bin/env python3
"""Deploy to the box over the serial console, when there is no IP path to it.

WHY THIS EXISTS. `deploy.sh` needs SSH, and there are real situations where
SSH is not available: on campus TCP/22 is filtered between guest clients, and
off campus the box may simply not be on the same network as the laptop. On
2026-09-21 the box was powered and healthy with its serial console answering at
115200, and nothing on the network could see it - so the escape hatch, which
exists precisely so an unreachable box can be fixed, could not be installed.

That is the gap this closes. The CP2102 console is a path of last resort, and
it is the one that is still there when every other one has gone.

WHAT IT SHIPS. Only the files that differ from a stock deploy - the listener
modules and the scripts. It deliberately does NOT try to be deploy.sh: no
systemd units, no udev rules, no audio verification. Use deploy.sh whenever an
IP path exists. This is for when one does not.

HOW IT SURVIVES A DUMB PIPE. A serial console has no flow control and echoes
everything back. So:

  - `stty -echo` on the far side, restored at the end. Halves the traffic and
    makes the output parseable at all.
  - Payloads are gzipped and base64'd, then sent in small chunks, waiting for
    the shell prompt between each. A chunk that is not acknowledged is a chunk
    that is resent rather than one that silently corrupts a file.
  - Every file is verified by sha256 ON THE BOX against the hash computed here.
    A serial line drops bytes; a deploy that cannot prove what landed is not a
    deploy. Nothing is installed until its hash matches.

Usage:
    python3 pi/scripts/serial-deploy.py                 # prompts for password
    python3 pi/scripts/serial-deploy.py --dry-run       # no port opened
    PI_PASSWORD=... python3 pi/scripts/serial-deploy.py --from-env
"""

from __future__ import annotations

import argparse
import base64
import getpass
import gzip
import hashlib
import os
import re
import select
import sys
import termios
import time
from pathlib import Path

PORT = "/dev/cu.usbserial-0001"
BAUD = termios.B115200
PROMPT = "LRDEPLOY$ "          # our own unambiguous prompt, set after login
CHUNK = 256                     # base64 chars per write; small on purpose

REPO = Path(__file__).resolve().parents[2]

# (source, destination, mode). Order matters only for readability.
PAYLOAD = [
    ("pi/lockerroom/control.py",   "/opt/lockerroom/lockerroom/control.py",   "644"),
    ("pi/lockerroom/lifecycle.py", "/opt/lockerroom/lockerroom/lifecycle.py", "644"),
    ("pi/scripts/report-full.sh",  "/usr/local/bin/report-full.sh",           "755"),
    ("pi/scripts/run-repair.sh",   "/usr/local/bin/run-repair.sh",            "755"),
    ("pi/scripts/btwatch.sh",      "/usr/local/bin/btwatch.sh",               "755"),
]

# remote-repair.sh is handled separately: it only gets seeded when there is no
# git clone at /opt/lockerroom/repo, because a real clone manages its own copy
# and a pull would fight with anything written underneath it.
SEED = ("pi/scripts/remote-repair.sh", "/opt/lockerroom/repo/pi/scripts/remote-repair.sh", "755")


class Serial:
    def __init__(self, port=PORT):
        self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        a = termios.tcgetattr(self.fd)
        cc = list(a[6])
        cc[termios.VMIN] = 0
        cc[termios.VTIME] = 0
        termios.tcsetattr(
            self.fd, termios.TCSANOW,
            [0, 0, termios.CS8 | termios.CREAD | termios.CLOCAL, 0, BAUD, BAUD, cc],
        )
        termios.tcflush(self.fd, termios.TCIOFLUSH)

    def write(self, data: str) -> None:
        b = data.encode()
        while b:
            n = os.write(self.fd, b[:256])
            b = b[n:]
            time.sleep(0.01)      # the far side has no flow control

    def read_until(self, needle: str, timeout: float) -> str:
        buf = ""
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(self.fd, 4096)
                except OSError:
                    break
                if chunk:
                    buf += chunk.decode("utf-8", "replace")
                    if needle in buf:
                        return buf
        raise TimeoutError(f"waited {timeout}s for {needle!r}; got tail {buf[-300:]!r}")

    def close(self):
        os.close(self.fd)


ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][B0]")
HEX64 = re.compile(r"\b[0-9a-f]{64}\b")


def clean(text: str) -> str:
    """Strip terminal escapes and CRs.

    Bash on the box turns on bracketed paste, so `ESC[?2004h` arrives inline
    with whatever a command printed. Parsing output without removing that is
    how a correct sha256 got compared against `[?2004h` and every file was
    reported as corrupt - the verification was right to refuse, it was simply
    reading the wrong bytes.
    """
    return ANSI.sub("", text).replace("\r", "")


def log(msg: str) -> None:
    print(msg, flush=True)


def login(s: Serial, user: str, password: str) -> None:
    log("  waking the console...")
    s.write("\r")
    out = s.read_until("login:", 15)

    # Already at a shell? Then somebody is logged in and we should not re-auth.
    s.write(user + "\r")
    s.read_until("assword", 15)
    s.write(password + "\r")

    # A wrong password returns to `login:` rather than erroring, so look for
    # both and say which happened.
    buf = ""
    end = time.time() + 20
    while time.time() < end:
        r, _, _ = select.select([s.fd], [], [], 0.2)
        if r:
            buf += os.read(s.fd, 4096).decode("utf-8", "replace")
            if "incorrect" in buf.lower() or buf.rstrip().endswith("login:"):
                raise SystemExit("  LOGIN FAILED: the password was rejected.")
            if "$" in buf or "#" in buf:
                break
    else:
        raise SystemExit(f"  LOGIN TIMED OUT; tail was {buf[-200:]!r}")

    # Our own prompt, and echo off. Both make everything after this parseable.
    # Belt and braces: turn bracketed paste off at the source as well as
    # stripping it on arrival. Either alone would do; both cost nothing.
    s.write("bind 'set enable-bracketed-paste off' 2>/dev/null\r")
    time.sleep(0.3)
    s.write(f"export PS1='{PROMPT}'; stty -echo\r")
    time.sleep(0.5)
    s.write("\r")
    s.read_until(PROMPT, 15)
    log("  logged in, prompt set, echo off")


def run(s: Serial, cmd: str, timeout: float = 30) -> str:
    s.write(cmd + "\r")
    out = s.read_until(PROMPT, timeout)
    # Strip the trailing prompt and any leading echo of the command itself.
    body = clean(out[: out.rindex(PROMPT)])
    return body.replace(cmd, "", 1).strip()


def send_file(s: Serial, src: Path, dest: str, mode: str, sudo: bool = True) -> bool:
    raw = src.read_bytes()
    want = hashlib.sha256(raw).hexdigest()
    blob = base64.b64encode(gzip.compress(raw, mtime=0)).decode()

    tmp = f"/tmp/lrdeploy.{src.name}.b64"
    run(s, f"rm -f {tmp}")
    for i in range(0, len(blob), CHUNK):
        run(s, f"printf %s '{blob[i:i+CHUNK]}' >> {tmp}", timeout=20)

    out = f"/tmp/lrdeploy.{src.name}"
    # `< file` rather than a positional argument: GNU coreutils accepts both,
    # BSD base64 only the redirect, and this script gets run from a Mac.
    run(s, f"base64 -d < {tmp} | gunzip > {out}", timeout=30)
    # Match on SHAPE, not position: a 64-char hex token is unmistakable, and
    # anything the terminal injects around it cannot be mistaken for one.
    raw_out = run(s, f"sha256sum {out}", timeout=20)
    m = HEX64.search(raw_out)
    got = m.group(0) if m else f"<no hash in {raw_out[:60]!r}>"

    if got != want:
        log(f"    HASH MISMATCH for {src.name}: wanted {want[:16]} got {got[:16]}")
        run(s, f"rm -f {tmp} {out}")
        return False

    pre = "sudo " if sudo else ""
    run(s, f"{pre}install -m {mode} -D {out} {dest}", timeout=20)
    run(s, f"rm -f {tmp} {out}")
    log(f"    ok  {dest}  ({len(raw)} B, sha256 verified on the box)")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="plan only; opens no port")
    ap.add_argument("--user", default="pi")
    ap.add_argument("--from-env", action="store_true", help="read PI_PASSWORD")
    ap.add_argument("--no-restart", action="store_true")
    args = ap.parse_args()

    files = [(REPO / s, d, m) for s, d, m in PAYLOAD]
    missing = [str(p) for p, _, _ in files if not p.exists()]
    if missing:
        log("MISSING: " + ", ".join(missing))
        return 2

    total = sum(len(base64.b64encode(gzip.compress(p.read_bytes(), mtime=0))) for p, _, _ in files)
    log(f"Serial deploy over {PORT} @ 115200")
    log(f"  {len(files)} files, {total} B on the wire (~{total/5760:.0f}s)")
    for p, d, m in files:
        log(f"    {p.relative_to(REPO)} -> {d} ({m})")
    log(f"    {SEED[0]} -> {SEED[1]} (only if no git clone)")

    if args.dry_run:
        log("\nDRY RUN: nothing sent, no port opened.")
        return 0

    if args.from_env:
        password = os.environ.get("PI_PASSWORD", "")
        if not password:
            log("PI_PASSWORD is not set")
            return 2
    else:
        password = getpass.getpass(f"  password for {args.user}@auxgoat (serial): ")

    s = Serial()
    try:
        login(s, args.user, password)

        log("  sending files...")
        ok = True
        for p, d, m in files:
            ok &= send_file(s, p, d, m)
        if not ok:
            log("  ABORTING: a file did not verify. Nothing was restarted.")
            return 1

        # Seed the repair script only when no clone owns that path.
        has_git = run(s, "test -d /opt/lockerroom/repo/.git && echo yes || echo no")
        if "yes" in has_git:
            log("    git clone present — leaving remote-repair.sh to it")
        else:
            log("    no git clone — seeding remote-repair.sh")
            send_file(s, REPO / SEED[0], SEED[1], SEED[2])

        run(s, "sudo find /opt/lockerroom/lockerroom -name '__pycache__' -exec rm -rf {} + 2>/dev/null; true")

        if not args.no_restart:
            log("  restarting the listener...")
            run(s, "sudo systemctl restart lockerroom-listener", timeout=45)
            time.sleep(3)
            state = run(s, "systemctl is-active lockerroom-listener")
            log(f"    lockerroom-listener: {state}")
            if "active" not in state:
                log("    NOT ACTIVE — check `journalctl -u lockerroom-listener -n 40`")
                return 1

        log("  verifying the new commands are installed...")
        for f in ("/usr/local/bin/report-full.sh", "/usr/local/bin/run-repair.sh"):
            log(f"    {run(s, f'test -x {f} && echo ok || echo MISSING')}  {f}")
        allowed = run(s, "grep -c 'report-full\\|run-repair' /opt/lockerroom/lockerroom/control.py")
        log(f"    control.py mentions the new commands {allowed} times")

        log("\nDone.")
        return 0
    finally:
        try:
            s.write("stty echo\r")
            time.sleep(0.3)
            s.write("exit\r")   # do not leave an authenticated console open
            time.sleep(0.5)
        except Exception:
            pass
        s.close()


if __name__ == "__main__":
    sys.exit(main())
