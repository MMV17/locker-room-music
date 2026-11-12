import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./../../api";
import { Fold as Section, Banner, Spinner, formatWhen, useConfirm } from "./../../components";
import type { PiCommand, PiInfo, PiReport } from "./types";
import type { Call } from "./adminApi";

/** How often Diagnostics refreshes while a command is in flight, and for
 *  WATCH_MS afterwards; and how often when nothing is going on. */
const FAST_MS = 3_000;
const SLOW_MS = 20_000;
const WATCH_MS = 6 * 60_000;

/**
 * The words a coach sees for each command, on the buttons and in the history
 * alike. The history used to print the protocol name ("run repair") for a
 * button that says "Try to fix it".
 */
const COMMAND_LABELS: Record<string, string> = {
  "report-full": "Check it",
  "run-repair": "Try to fix it",
  "restart-listener": "Restart the app",
  reboot: "Reboot the box",
  "update-software": "Update speaker software",
  "scan-speakers": "Scan for speakers",
  "report-status": "Quick check",
  "forget-selected-phone": "Forget the selected phone",
};

function commandLabel(cmd: string): string {
  return COMMAND_LABELS[cmd] ?? cmd.replace(/-/g, " ");
}


/**
 * Remote control for the Pi.
 *
 * The locker room network blocks every inbound path to it - 7844 is closed so
 * Cloudflare Tunnel cannot run, Tailscale is blocked by SNI, and TCP/22 is
 * filtered between guest clients. So the Pi polls out on 443 and picks work up
 * from here. Expect up to a minute of lag: that is the beacon interval, not a
 * hang.
 */
export function Speaker({ call }: { call: Call }) {
  const [commands, setCommands] = useState<PiCommand[] | null>(null);
  const [reports, setReports] = useState<PiReport[]>([]);
  // Which command rows are expanded. A dump is long, so the history stays a
  // list of one-liners until somebody asks for one — but "asks for one" has to
  // be possible, which before 2026-09-21 it was not.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [info, setInfo] = useState<PiInfo | null>(null);

  /**
   * navigator.clipboard needs a secure context; the site is https so it is
   * there, but it still rejects when the page is not focused or permission is
   * refused. Say so rather than silently doing nothing — a Copy button that
   * appears to work and does not is worse than one that admits it failed.
   */
  const copy = async (kind: string, body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Could not reach the clipboard — select the text and copy it by hand.");
    }
  };

    /**
   * The four things a coach actually does to the box, named for what they DO.
   *
   * These used to be rendered straight off the allowlist —
   * `allowed.map(cmd => cmd.replace(/-/g, " "))` — so every internal command
   * name became a button: "restart listener", "report status", "report full",
   * "forget selected phone". That is the protocol leaking onto a coach's
   * screen. Two of them did not even belong: "scan speakers" duplicates the
   * Scan button below, and "forget selected phone" does nothing at all without
   * a target, which is set from the Bluetooth pairings section.
   *
   * "report status" is gone from the UI but stays on the allowlist — it is
   * strictly less than a full check, and two buttons that differ only in
   * thoroughness is a choice nobody wants to make while a speaker is dead.
   */
  const ACTIONS: { cmd: string; label: string; sub: string; danger?: boolean }[] = [
    { cmd: "report-full", label: COMMAND_LABELS["report-full"], sub: "Full diagnostic. Safe while music is playing." },
    { cmd: "run-repair", label: COMMAND_LABELS["run-repair"], sub: "Restarts Bluetooth and the services. Stops the music." , danger: true },
    { cmd: "restart-listener", label: COMMAND_LABELS["restart-listener"], sub: "Just the listener. Usually enough.", danger: true },
    { cmd: "reboot", label: COMMAND_LABELS["reboot"], sub: "Last resort. About a minute offline.", danger: true },
  ];

  const send = async (cmd: string, label: string) => {
    if (cmd !== "report-full") {
      const ok = await confirm({
        title: `${label}?`,
        body:
          cmd === "reboot"
            ? "Music stops for about a minute, and whoever is DJing is cut off."
            : cmd === "run-repair"
              ? "Restarts Bluetooth and the speaker's services. Music stops if anything is playing, and the speaker can show as offline for a few minutes. It will not touch the listener's code."
              : "Restarts the listener. Anything playing right now is interrupted.",
        confirmLabel: label,
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await call("/api/admin/pi/commands", {
        method: "POST",
        body: JSON.stringify({ command: cmd }),
      });
      setSent(`${label} — queued. The speaker picks it up on its next check-in.`);
      watch();
    } catch (e) {
      setError(errorMessage(e, "Could not queue that"));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Wireless update. A box that has never reported its software is still on
   * the listener from before the updater existed, so the server queues Run
   * repair instead (which installs the updater) and the confirm has to say
   * what that really costs.
   */
  const updateSoftware = async () => {
    const bootstrap = !info?.software;
    const ok = await confirm({
      title: "Update speaker software?",
      body: bootstrap
        ? "This speaker has not had a wireless update before. The first one goes through Run repair: Bluetooth restarts, music stops if anything is playing, and the speaker can show as offline for a few minutes."
        : "Installs the latest speaker software from GitHub and restarts the listener. Music stops for a moment. If the new version cannot check in within a few minutes, the speaker puts the old version back by itself.",
      confirmLabel: "Update",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ queued: string; bootstrap: boolean }>("/api/admin/pi/commands", {
        method: "POST",
        body: JSON.stringify({ command: "update-software" }),
      });
      setSent(
        r.bootstrap
          ? "Run repair — queued, to install the updater. The speaker picks it up on its next check-in."
          : "Update speaker software — queued. The speaker picks it up on its next check-in.",
      );
      watch();
    } catch (e) {
      setError(errorMessage(e, "Could not queue that"));
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(() => {
    call<{ commands: PiCommand[]; allowed: string[] } & PiInfo>("/api/admin/pi/commands")
      .then((r) => {
        setCommands(r.commands);
        setInfo({
          software: r.software ?? null,
          via_host: r.via_host ?? null,
          clock_skew_ms: r.clock_skew_ms ?? null,
        });
      })
      // A failed REFRESH keeps what is on screen; only a failed first load has
      // nothing to keep. Blanking the list on one dropped request would make
      // a flaky connection look like a speaker with no history.
      .catch(() => setCommands((prev) => prev ?? []));
    // Separate request because it is separate storage. A failure here must not
    // blank the command list — the buttons are the half you need when the box
    // is misbehaving.
    call<{ reports: PiReport[] }>("/api/admin/pi/reports")
      .then((r) => setReports(r.reports ?? []))
      .catch(() => setReports((prev) => prev));
  }, [call]);

  // THIS SCREEN REFRESHES ITSELF. It used to load once, so a report, a repair
  // log or the result of an update only appeared after reloading the page by
  // hand - while the screen sat there saying "queued".
  //
  // Two speeds. While something is in flight it checks every few seconds, and
  // it keeps doing so for WATCH_MS after the last command finished: an update
  // answers "scheduled" at once and sends its real outcome a few minutes
  // later, and a repair's log arrives a beat after its one-line result.
  // Otherwise it idles at SLOW_MS, which is enough to keep the software
  // version, check-in address and clock warning honest. Nothing is fetched
  // while the tab is hidden, and it catches up the moment it is shown again.
  const watchUntil = useRef(0);
  const watch = useCallback(() => {
    watchUntil.current = Date.now() + WATCH_MS;
    load();
  }, [load]);

  const outstanding = !!commands?.some((c) => !c.completed_at);
  useEffect(() => {
    if (outstanding) watchUntil.current = Date.now() + WATCH_MS;
  }, [outstanding, commands]);

  useEffect(() => {
    load();
    let timer: number | undefined;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      const fast = Date.now() < watchUntil.current;
      timer = window.setTimeout(() => {
        if (!document.hidden) load();
        schedule();
      }, fast ? FAST_MS : SLOW_MS);
    };
    schedule();
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const label = (c: PiCommand) =>
    c.completed_at ? (c.ok ? "done" : "failed") : c.dispatched_at ? "running" : "queued";

  return (
    <Section title="Diagnostics">
      {dialog}
      {error && <Banner kind="bad">{error}</Banner>}
      {sent && <Banner kind="info">{sent}</Banner>}
      <p className="t-sub" style={{ marginBottom: 12 }}>
        Check the box, try to fix it, and read what it sent back. It checks in
        every ten seconds or so, and this screen updates by itself: no need to
        reload.
      </p>

      {info && (
        <p className="t-sub" style={{ marginBottom: 12 }}>
          Speaker software:{" "}
          {info.software ? (
            <>
              <strong>{info.software.commit.slice(0, 12)}</strong>
              {info.software.installed_at
                ? ` - updated ${formatWhen(info.software.installed_at)}`
                : ""}
            </>
          ) : (
            "not reported yet"
          )}
          {info.via_host && (
            <>
              <br />
              Checking in through: <strong>{info.via_host}</strong>
            </>
          )}
        </p>
      )}
      {/* The Pi has no clock battery. Votes and plays carry its timestamps,
          so a clock minutes off is worth a coach knowing about. */}
      {info?.clock_skew_ms != null && Math.abs(info.clock_skew_ms) > 2 * 60_000 && (
        <Banner kind="bad">
          The speaker's clock is {Math.round(Math.abs(info.clock_skew_ms) / 60_000)} minutes{" "}
          {info.clock_skew_ms > 0 ? "behind" : "ahead"}. Song times it reports may be off.
        </Banner>
      )}

      {/* The actions sit WITH their results rather than in Speaker output.
          Pressing "Check it" in one section and reading its report in another
          was the awkward seam in the first cut of this screen — the whole
          point of a diagnostic is the thing it tells you. */}
      <div className="rows" style={{ marginBottom: 16 }}>
        {ACTIONS.map((a) => (
          <div key={a.cmd} className="row">
            <span className="row-main">
              <span className="row-title">{a.label}</span>
              <span className="row-sub">{a.sub}</span>
            </span>
            <button
              className={a.danger ? "btn-quiet is-danger" : "btn"}
              disabled={busy}
              onClick={() => send(a.cmd, a.label)}
            >
              Run
            </button>
          </div>
        ))}
        <div className="row">
          <span className="row-main">
            <span className="row-title">Update speaker software</span>
            <span className="row-sub">
              {info && !info.software
                ? "First update goes through Run repair. Stops the music."
                : "Latest version from GitHub. Rolls back by itself if it fails."}
            </span>
          </span>
          <button className="btn-quiet is-danger" disabled={busy} onClick={updateSoftware}>
            Run
          </button>
        </div>
      </div>

      {!commands ? (
        <Spinner />
      ) : commands.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing sent yet</p>
          Commands you send to the speaker appear here with their result.
        </div>
      ) : (
        <div className="rows">
          {commands.slice(0, 6).map((c) => {
            /* Until 2026-09-21 this rendered `result.split("\n")[0].slice(0, 40)`,
               so a command could collect exactly the right answer and still
               never show it to anyone. That is not a cosmetic bug: on
               2026-09-20 the service states that WERE collected never reached
               a human, and the fault took an hour to find. The summary line
               stays — a history of six one-liners is the right default — but
               the full result is now one tap away. */
            const expanded = !!open[c.id];
            const summary = c.result ? c.result.split("\n")[0] : "";
            const hasMore =
              !!c.result && (c.result.includes("\n") || c.result !== summary);
            return (
              /* Every row uses the block layout with a flex header, expandable
                 or not. Visually identical to the old flat row, and it avoids
                 two different DOM shapes for what is one list. */
              <div key={c.id} className="row is-expandable">
                <div className="row-head">
                  <span className="row-main">
                    <span className="row-title">{commandLabel(c.command)}</span>
                    <span className="row-sub">
                      {label(c)} · {formatWhen(c.created_at)}
                      {summary ? ` · ${summary}` : ""}
                    </span>
                  </span>
                  {hasMore ? (
                    <button
                      className="btn-quiet"
                      onClick={() => setOpen((o) => ({ ...o, [c.id]: !expanded }))}
                    >
                      {expanded ? "Hide" : "Show all"}
                    </button>
                  ) : (
                    <button className="btn-quiet" onClick={load}>
                      Refresh
                    </button>
                  )}
                </div>
                {hasMore && expanded && <pre className="dump">{c.result}</pre>}
              </div>
            );
          })}
        </div>
      )}

      {/* The long-form output. Its own storage, because `pi_commands.result` is
          cut to 2000 characters server-side and a truncated dump hides the line
          you went looking for — see migration 007. Each kind keeps its latest,
          so a repair log does not overwrite the diagnostic that justified
          running it; reading the two together is the whole workflow. */}
      {/* FOLDED, because a full report is 20 KB and it was pushing the command
          history off the bottom of the screen every time one arrived. Collapsed
          it is a one-line receipt; open it is the whole dump. */}
      {reports.map((r) => (
        <details key={r.kind} className="fold">
          <summary className="fold-head">
            <span className="fold-title t-section" style={{ fontSize: 16 }}>
              {r.kind === "run-repair"
                ? "Repair log"
                : r.kind === "update"
                  ? "Last update"
                  : "Full report"}
            </span>
            <span className="dump-when" style={{ marginLeft: "auto", marginRight: 10 }}>
              <span className={r.ok ? "dump-ok" : "dump-bad"}>
                {r.ok ? "ok" : "problem"}
              </span>{" "}
              · {formatWhen(r.collected_at)}
            </span>
            <span className="fold-mark" aria-hidden="true" />
          </summary>
          <div className="dump-action">
            {/* The report is long and the useful thing to do with it is send it
                to somebody. Selecting 20 KB of monospace by dragging on a phone
                is not a realistic way to do that. */}
            <button className="btn-quiet" onClick={() => copy(r.kind, r.body)}>
              {copied === r.kind ? "Copied" : "Copy all"}
            </button>
          </div>
          <pre className="dump">{r.body}</pre>
        </details>
      ))}
    </Section>
  );
}
