import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./../api";
import { Fold as Section, Spinner, formatWhen, useConfirm } from "./../components";
import { useNavigate } from "./../router";
import { cacheTheme } from "./../theme";
import type { Theme } from "./../theme";

/**
 * Coach-facing. Gated by its own password rather than the team session — a
 * coach setting up the roster has no reason to have joined as a player first.
 *
 * The password is held in sessionStorage, not localStorage: it closes with
 * the tab, which is the right default for a credential that gates roster
 * edits and voiding.
 */

const PW_KEY = "lr_admin_pw";

interface AdminUser {
  id: string;
  name: string;
  jersey_number: string | null;
  first_name: string;
  last_name: string;
  active: number;
  // Only used to tell the coach what deleting this person costs. Deleting is
  // irreversible, so the confirm has to name the damage rather than ask for a
  // blind yes.
  plays: number;
  votes: number;
}

interface PiCommand {
  id: string;
  command: string;
  created_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  ok: number | null;
  result: string | null;
}

/**
 * Long-form output from the box: a diagnostic dump or a repair log.
 *
 * Kept apart from PiCommand.result because it IS apart — the server truncates
 * that column to 2000 characters, so the body travels on its own beacon
 * payload into `pi_reports`. See backend/migrations/007-remote-diagnostics.sql.
 */
interface PiReport {
  kind: string;
  collected_at: string;
  body: string;
  ok: boolean;
}

interface BtDevice {
  mac: string;
  // null means the device advertises no name; we show the MAC for these rather
  // than a blank row, which would read as a bug.
  name: string | null;
  cod: number | null;
  rssi: number | null;
}

interface SpeakerState {
  devices: BtDevice[];
  // "" is a real answer meaning wired output on purpose. null means nobody has
  // ever chosen, in which case the Pi is still following its own config file.
  selected: string | null;
  selected_name: string | null;
  output: { kind: string; card: string | null } | null;
  relay_connected: boolean | null;
  relay_error: string | null;
  speaker_online: boolean;
}

interface AdminDevice {
  mac_hash: string;
  mac_hint: string;
  alias: string | null;
  claimed_at: string | null;
  owner_name: string | null;
  plays: number;
}

interface AdminPlay {
  id: string;
  title: string;
  artist: string | null;
  dj_name: string | null;
  started_at: string;
  counted: number;
  voided: number;
}

export function Admin({ teamName }: { teamName: string }) {
  const navigate = useNavigate();
  const [pw, setPw] = useState(() => sessionStorage.getItem(PW_KEY) ?? "");
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const res = await fetch(path, {
        credentials: "same-origin",
        ...init,
        headers: {
          "X-Admin-Password": pw,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, (body as any).error ?? "Something went wrong");
      return body as T;
    },
    [pw],
  );

  // Re-authenticate silently on reload when the password is still in session.
  //
  // Mount only, and against the stored value rather than the live field. With
  // `pw` in the dependency list this fired an admin request on every
  // keystroke, and the form unmounted underneath the user mid-submit as soon
  // as one of those partial attempts happened to succeed.
  useEffect(() => {
    const stored = sessionStorage.getItem(PW_KEY);
    if (!stored) return;
    fetch("/api/admin/users", { headers: { "X-Admin-Password": stored } })
      .then((r) => setAuthed(r.ok))
      .catch(() => setAuthed(false));
  }, []);

  if (!authed) {
    return (
      <main className="screen" style={{ paddingTop: 48 }}>
        <p className="t-label">{teamName}</p>
        <h1 className="t-display" style={{ margin: "6px 0 26px" }}>
          Admin
        </h1>
        {error && <div className="banner is-bad">{error}</div>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await call("/api/admin/users");
              sessionStorage.setItem(PW_KEY, pw);
              setAuthed(true);
            } catch {
              setError("Wrong password.");
            }
          }}
        >
          <label className="field">
            <span className="t-label">Admin password</span>
            <input
              className="input"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoFocus
            />
          </label>
          <button className="btn is-primary is-block" disabled={!pw}>
            Sign in
          </button>
        </form>
        <div className="center">
          <button className="btn-quiet" onClick={() => navigate("/")}>
            Back to the app
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="screen" style={{ paddingBottom: 40 }}>
      <header className="screen-head">
        <h1 className="t-display">Admin</h1>
        <button className="btn-quiet" onClick={() => navigate("/")}>
          Done
        </button>
      </header>

      {/* Ordered by why you opened this screen, not by when it was built.
          It used to lead with the team name — a thing you set once a season —
          and put the remote commands ABOVE the speaker picker they operate on.

          The split that matters is doing vs reading, and output vs input:
          Speaker output is where you change and fix the box, Bluetooth
          pairings is the connections coming IN to it, and Diagnostics is
          purely what came back. Forget used to sit on the output list, which
          put a destructive button on the one list that answers a different
          question entirely. */}
      <SpeakerOutput call={call} />
      <Pairings call={call} />
      <Devices call={call} />
      <Roster call={call} />
      <Plays call={call} />
      <Covers call={call} />
      <Appearance call={call} />
      <Speaker call={call} />
    </main>
  );
}

type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * The team's name. That is the whole of it now.
 *
 * There used to be a colour picker here, and one hex drove the entire brand:
 * the tab underline, jersey numbers, buttons. It is gone, and so is
 * `theme.primary` — the palette is fixed to the logo's black, ivory and
 * antique gold. A school is named, not coloured. See styles.css.
 */
function Appearance({ call }: { call: Call }) {
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/theme")
      .then((r) => r.json())
      .then((t: Theme) => setName(t.team_name))
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setError(null);
    try {
      const t = await call<Theme & { ok: true }>("/api/admin/theme", {
        method: "PUT",
        body: JSON.stringify({ team_name: name }),
      });
      cacheTheme(t);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    }
  };

  return (
    <Section title="Team">
      {error && <div className="banner is-bad">{error}</div>}
      {saved && <div className="banner is-ok">Saved.</div>}

      <label className="field">
        <span className="t-label">Team name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <p className="t-sub" style={{ marginBottom: 12 }}>
        Shown in the header and on the join screen. The colours are AuxGoat's and are
        not configurable.
      </p>

      <button className="btn is-primary is-block" onClick={save}>
        Save
      </button>
    </Section>
  );
}

function Roster({ call }: { call: Call }) {
  const { confirm, dialog } = useConfirm();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [jersey, setJersey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call<{ users: AdminUser[] }>("/api/admin/users")
      .then((r) => setUsers(r.users))
      .catch(() => setUsers([]));
  }, [call]);

  useEffect(load, [load]);

  // Players add themselves at signup; this is the fallback for the one who
  // cannot. A duplicate name+number comes back 409 rather than quietly
  // creating a second row.
  const add = async () => {
    if (!first.trim() || !last.trim()) return;
    setError(null);
    try {
      await call("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          first_name: first,
          last_name: last,
          jersey_number: jersey || null,
        }),
      });
      setFirst("");
      setLast("");
      setJersey("");
      load();
    } catch {
      setError("That player already exists.");
    }
  };

  const toggle = async (u: AdminUser) => {
    await call(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: !u.active }),
    });
    load();
  };

  // Deactivate is still the right tool for someone who left the team — it
  // keeps their record and their name on the leaderboard. This is for the rows
  // that should never have existed: a typo, a duplicate, a test signup. Since
  // players sign themselves up with nothing but the team code, those pile up.
  const remove = async (u: AdminUser) => {
    const kept = u.plays
      ? `Their ${u.plays} ${u.plays === 1 ? "song stays" : "songs stay"} in history as Unclaimed`
      : "They have no songs in history";
    const lost = u.votes
      ? `, and their ${u.votes} ${u.votes === 1 ? "vote stops" : "votes stop"} counting`
      : "";
    const ok = await confirm({
      title: `Delete ${u.name}?`,
      body: `${kept}${lost}. This cannot be undone.`,
      confirmLabel: "Delete player",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await call(`/api/admin/users/${u.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete that player");
    }
  };

  return (
    <Section title="Roster">
      {dialog}
      {error && <div className="banner is-bad">{error}</div>}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          className="input"
          placeholder="First name"
          value={first}
          onChange={(e) => setFirst(e.target.value)}
        />
        <input
          className="input"
          placeholder="Last name"
          value={last}
          onChange={(e) => setLast(e.target.value)}
        />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          className="input"
          placeholder="#"
          value={jersey}
          onChange={(e) => setJersey(e.target.value)}
          inputMode="numeric"
          maxLength={3}
          style={{ width: 78 }}
        />
        <button
          className="btn is-primary"
          onClick={add}
          disabled={!first.trim() || !last.trim()}
        >
          Add
        </button>
      </div>

      {!users ? (
        <Spinner />
      ) : (
        <div className="rows">
          {users.map((u) => (
            <div key={u.id} className="row">
              <span className="jersey is-sm">{u.jersey_number || u.name[0]}</span>
              <span className="row-main">
                <span className="row-title" style={{ opacity: u.active ? 1 : 0.5 }}>
                  {u.name}
                </span>
                <span className="row-sub">#{u.jersey_number ?? "—"}</span>
              </span>
              {/* Grouped so the row's 14px gap falls once, before the pair,
                  rather than between two already-padded buttons — the name
                  needs that width back on a phone. */}
              <span style={{ display: "flex", flexShrink: 0 }}>
                <button className="btn-quiet" onClick={() => toggle(u)}>
                  {u.active ? "Deactivate" : "Restore"}
                </button>
                <button className="btn-quiet is-danger" onClick={() => remove(u)}>
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Devices({ call }: { call: Call }) {
  const { confirm, dialog } = useConfirm();
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call<{ devices: AdminDevice[] }>("/api/admin/devices")
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]));
  }, [call]);

  useEffect(load, [load]);

  const unclaim = async (d: AdminDevice) => {
    await call(`/api/admin/devices/${d.mac_hash}/unclaim`, { method: "POST" });
    load();
  };

  // For clearing out noise: a visitor's phone, a laptop that paired once. The
  // songs stay, but they lose the phone they came from — and an unclaimed song
  // can then never be claimed, because picking your phone off the list is the
  // only thing tying a play to a person. Worth saying out loud in the confirm.
  const remove = async (d: AdminDevice) => {
    const name = d.alias ?? "this phone";
    const cost = d.plays
      ? d.owner_name
        ? `Its ${d.plays} ${d.plays === 1 ? "song stays" : "songs stay"} on record with ${d.owner_name}.`
        : `Its ${d.plays} unclaimed ${d.plays === 1 ? "song stays" : "songs stay"} on record, and nobody will be able to claim ${d.plays === 1 ? "it" : "them"} afterwards.`
      : "It has played nothing.";
    const ok = await confirm({
      title: `Delete ${name}?`,
      body: `${cost} It comes back if that phone plays again.`,
      confirmLabel: "Delete phone",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await call(`/api/admin/devices/${d.mac_hash}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete that phone");
    }
  };

  return (
    <Section title="Phones">
      {dialog}
      {error && <div className="banner is-bad">{error}</div>}
      <p className="t-sub" style={{ marginBottom: 12 }}>
        Un-claiming leaves the songs on record but removes DJ credit for them. Deleting
        removes the phone itself — the songs stay, and the phone reappears the next time
        it plays.
      </p>
      {!devices ? (
        <Spinner />
      ) : devices.length === 0 ? (
        <p className="t-sub">No phones have played yet.</p>
      ) : (
        <div className="rows">
          {devices.map((d) => (
            <div key={d.mac_hash} className="row">
              <span className="row-main">
                <span className="row-title">{d.alias ?? "Unknown phone"}</span>
                <span className="row-sub">
                  Ends in {d.mac_hint} · {d.plays} {d.plays === 1 ? "song" : "songs"} ·{" "}
                  {d.owner_name ?? "unclaimed"}
                </span>
              </span>
              <span style={{ display: "flex", flexShrink: 0 }}>
                {d.owner_name && (
                  <button className="btn-quiet" onClick={() => unclaim(d)}>
                    Un-claim
                  </button>
                )}
                <button className="btn-quiet is-danger" onClick={() => remove(d)}>
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/**
 * Voiding a play drops it from every ranking without deleting the row —
 * a season of data is not reproducible. Voiding an individual *vote* stays
 * API-only; picking one vote out of a tally is not a phone-screen task.
 */
/**
 * Bluetooth pairings — the INPUT side.
 *
 * Forget used to sit on the speaker picker, and that was wrong in a way worth
 * writing down: that list answers "what does the box play OUT through", and a
 * pairing answers "what connects IN to it". A JBL and a teammate's iPhone were
 * appearing as near-identical rows with opposite meanings, and the destructive
 * button was on the output list.
 *
 * WHAT THIS LIST ACTUALLY IS, because it is not quite "paired devices":
 * bt-scan.sh reports "everything nearby plus everything ever paired", so a
 * device here may never have been bonded. That is deliberate on its side — a
 * paired-but-switched-off speaker has to stay selectable — and it means Forget
 * can be pressed on something that was never paired. bt-forget.sh answers that
 * honestly rather than claiming success, so the imprecision is safe to leave.
 */
function Pairings({ call }: { call: Call }) {
  const { confirm, dialog } = useConfirm();
  const [state, setState] = useState<SpeakerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call<SpeakerState>("/api/admin/pi/speakers")
      .then(setState)
      .catch(() => setState(null));
  }, [call]);
  useEffect(load, [load]);

  const forget = async (mac: string, name: string | null) => {
    const ok = await confirm({
      title: `Forget ${name ?? mac}?`,
      body:
        "Use this when someone forgot the speaker on their phone and now cannot reconnect. They will have to pair again — one tap on their side. Nobody else is affected.",
      confirmLabel: "Forget it",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await call("/api/admin/pi/forget", {
        method: "POST",
        body: JSON.stringify({ mac }),
      });
      // Nothing changes on screen until the Pi picks the command up on its next
      // beacon, and the row stays either way — this list is what the last SCAN
      // saw, not what is currently bonded. So say so rather than looking broken.
      setNote(`Queued. ${name ?? mac} will be forgotten on the speaker's next check-in.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not forget that device");
    } finally {
      setBusy(false);
    }
  };

  const devices = state?.devices ?? [];

  return (
    <Section title="Bluetooth pairings">
      {dialog}
      {error && <div className="banner is-bad">{error}</div>}
      {note && <div className="banner is-info">{note}</div>}

      <p className="t-sub" style={{ marginBottom: 12 }}>
        What the speaker has paired with or seen nearby. Forget one when
        somebody removed AuxGoat on their phone and now cannot reconnect —
        Bluetooth has no way to tell us they did, so the speaker keeps a
        pairing they no longer have and refuses them.
      </p>

      {devices.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing seen yet</p>
          Run a scan from Speaker output first.
        </div>
      ) : (
        <div className="rows">
          {devices.map((d) => {
            const chosen = state?.selected === d.mac;
            return (
              <div key={d.mac} className="row">
                <span className="row-main">
                  <span className="row-title">{d.name ?? d.mac}</span>
                  <span className="row-sub">
                    {chosen ? "This is the output speaker" : d.name ? d.mac : "No name"}
                  </span>
                </span>
                {/* Not offered for the speaker in use: forgetting it drops
                    audio with no error anywhere and costs the one-tap return.
                    The server refuses it and the Pi refuses it again — but not
                    drawing the button is the only one of the three a coach
                    ever sees. */}
                {!chosen && (
                  <button
                    className="btn-quiet is-danger"
                    disabled={busy}
                    onClick={() => forget(d.mac, d.name)}
                  >
                    Forget
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function Plays({ call }: { call: Call }) {
  const { confirm, dialog } = useConfirm();
  const [plays, setPlays] = useState<AdminPlay[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call<{ plays: AdminPlay[]; total: number }>("/api/admin/plays")
      .then((r) => {
        setPlays(r.plays);
        setTotal(r.total);
      })
      .catch(() => setPlays([]));
  }, [call]);

  useEffect(load, [load]);

  const voidPlay = async (p: AdminPlay) => {
    const ok = await confirm({
      title: `Void "${p.title}"?`,
      body: "It stays on record but stops counting toward every ranking.",
      confirmLabel: "Void song",
      danger: true,
    });
    if (!ok) return;
    await call(`/api/admin/plays/${p.id}/void`, { method: "POST" });
    load();
  };

  // For the end of a test run or the start of a season. The leaderboards are
  // cumulative, so without this a week of experiments sits on top of the first
  // real session forever.
  const clearAll = async () => {
    // One dialog, not two. The second prompt existed because a native
    // confirm's button just says OK, so the only way to slow someone down was
    // to ask twice. A button that says "Clear 66 songs" is stronger protection
    // than a second identical prompt, and does not train anyone to double-tap.
    const ok = await confirm({
      title: "Clear history?",
      body: `All ${total} ${total === 1 ? "song stops" : "songs stop"} counting toward every ranking and the leaderboards go empty. The songs stay on record, but this cannot be undone from here.`,
      confirmLabel: `Clear ${total} ${total === 1 ? "song" : "songs"}`,
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      const r = await call<{ voided: number; spared: number }>(
        "/api/admin/plays/void-all",
        { method: "POST" },
      );
      if (r.spared) {
        setError(
          `Cleared ${r.voided}. The song on the speaker right now was left alone — clear again once it finishes.`,
        );
      }
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not clear history");
    }
  };

  return (
    <Section
      title="Recent plays"
      action={
        <button
          className="btn-quiet is-danger"
          onClick={clearAll}
          disabled={!total}
          /* Right padding dropped so it sits flush with the section edge;
             the vertical padding stays, because it is the tap target. */
          style={{ flexShrink: 0, padding: "8px 0 8px 10px" }}
        >
          Clear history ({total})
        </button>
      }
    >
      {dialog}
      {error && <div className="banner is-bad">{error}</div>}
      {!plays ? (
        <Spinner />
      ) : plays.length === 0 ? (
        <p className="t-sub">Nothing has played yet.</p>
      ) : (
        <>
          <div className="rows">
          {plays.map((p) => (
            <div key={p.id} className="row">
              <span className="row-main">
                <span className="row-title" style={{ opacity: p.voided ? 0.45 : 1 }}>
                  {p.title}
                </span>
                <span className="row-sub">
                  {p.dj_name ?? "Unclaimed"} · {formatWhen(p.started_at)}
                  {!p.counted && " · skipped"}
                  {!!p.voided && " · voided"}
                </span>
              </span>
              {!p.voided && (
                <button className="btn-quiet is-danger" onClick={() => voidPlay(p)}>
                  Void
                </button>
              )}
            </div>
          ))}
          </div>
        </>
      )}
    </Section>
  );
}

interface RetryResult {
  retried: number;
  found: number;
  remaining: number;
  next_offset: number;
  failures: { title: string; artist: string | null; why: string[] }[];
}

/**
 * Album covers that came back as a colour block.
 *
 * The retry endpoint existed since 2026-08-05 but had no button, so the only
 * way to heal a missing cover was curl. And it answered with a count, which
 * on 2026-09-27 — every song a colour block — could not say whether Deezer
 * refused, iTunes refused, or both answered and the matcher said no. It shows
 * the reason now, per song, because the reason IS the diagnosis.
 *
 * Batched server-side (a Worker has a cap on outbound fetches per request),
 * so "Next batch" carries the cursor the last answer handed back.
 */
function Covers({ call }: { call: Call }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RetryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (offset: number) => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await call<RetryResult>("/api/admin/artwork/retry", {
          method: "POST",
          body: JSON.stringify({ offset }),
        }),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not retry covers");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Album covers">
      {error && <div className="banner is-bad">{error}</div>}
      <div className="rows" style={{ marginBottom: result ? 12 : 0 }}>
        <div className="row">
          <span className="row-main">
            <span className="row-title">Find missing covers</span>
            <span className="row-sub">
              Looks up songs showing a colour block again. Safe any time.
            </span>
          </span>
          <button className="btn" disabled={busy} onClick={() => run(0)}>
            {busy ? "Looking…" : "Run"}
          </button>
        </div>
      </div>

      {result && (
        <>
          <p className="t-sub" style={{ marginBottom: 8 }}>
            {result.retried === 0
              ? "No songs are missing a cover."
              : `Tried ${result.retried}, found ${result.found}.` +
                (result.remaining ? ` ${result.remaining} more to try.` : "")}
          </p>
          {result.failures.length > 0 && (
            <div className="rows">
              {result.failures.map((f, i) => (
                <div key={i} className="row">
                  <span className="row-main">
                    <span className="row-title">{f.title}</span>
                    <span className="row-sub">
                      {f.artist ?? "Unknown artist"} · {f.why.join(" · ")}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {result.remaining > 0 && (
            <button
              className="btn-quiet"
              disabled={busy}
              onClick={() => run(result.next_offset)}
              style={{ marginTop: 8 }}
            >
              Next batch
            </button>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * Which speaker the box plays OUT through.
 *
 * The flow this is built around: press Scan, wait for it to say scanning, THEN
 * put the speaker in pairing mode, then pick it. That order is deliberate and
 * the instruction text is load-bearing. The Pi idles at a 60-second beacon, so
 * the FIRST press can wait that long before the box even hears about it —
 * nothing can tell the Pi to pay attention before it next checks in. Putting
 * the wait in front of the pairing window rather than inside it is what stops
 * a speaker timing out of pairing mode while we queue. After that first press
 * the box is attentive and everything is seconds.
 *
 * Devices are SORTED, never filtered. Class of Device is self-reported and some
 * speakers get it wrong or leave it blank, so a filter can hide the exact
 * speaker somebody is holding — the one failure that would make this screen
 * untrustworthy.
 */

/** Bluetooth major device class 0x04 is Audio/Video. */
function isAudio(cod: number | null): boolean {
  return cod !== null && ((cod >> 8) & 0x1f) === 0x04;
}

function outputLabel(s: SpeakerState): string {
  if (!s.output) return "Unknown — the speaker hasn't reported yet";
  if (s.output.kind === "relay") {
    return `Bluetooth → ${s.selected_name || s.output.card || "a speaker"}`;
  }
  if (s.output.kind === "usb") return "USB audio";
  if (s.output.kind === "jack") return "3.5mm jack";
  return s.output.kind;
}

function SpeakerOutput({ call }: { call: Call }) {
  const [state, setState] = useState<SpeakerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Without this, a bare `confirm` silently resolves to window.confirm — the
  // typechecker caught it, but only because the signatures differ.
  const [scanState, setScanState] = useState<"idle" | "queued" | "scanning" | "done">("idle");

  const load = useCallback(
    () =>
      call<SpeakerState>("/api/admin/pi/speakers")
        .then(setState)
        .catch(() => setState(null)),
    [call],
  );

  useEffect(() => {
    load();
  }, [load]);

  // While a scan is in flight, watch the command history for it. Polling only
  // then, and never otherwise: this screen is open for minutes at a time and
  // there is nothing to see between scans.
  useEffect(() => {
    if (scanState !== "queued" && scanState !== "scanning") return;
    const timer = setInterval(async () => {
      try {
        const r = await call<{ commands: PiCommand[] }>("/api/admin/pi/commands");
        const scan = r.commands.find((c) => c.command === "scan-speakers");
        if (!scan) return;
        if (scan.completed_at) {
          setScanState("done");
          load();
        } else if (scan.dispatched_at) {
          setScanState("scanning");
        }
      } catch {
        /* a failed poll is not worth surfacing; the next one is 3s away */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [scanState, call, load]);

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("/api/admin/pi/commands", {
        method: "POST",
        body: JSON.stringify({ command: "scan-speakers" }),
      });
      setScanState("queued");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start a scan");
    } finally {
      setBusy(false);
    }
  };

  const choose = async (mac: string | null, name: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await call("/api/admin/pi/speakers", {
        method: "PUT",
        body: JSON.stringify({ mac, name }),
      });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not set that speaker");
    } finally {
      setBusy(false);
    }
  };

  // Audio gear first, then the strongest signal — the speaker in your hand is
  // usually the nearest one. Unknown class and unknown signal both sort last
  // rather than being guessed at in either direction.
  const sorted = state
    ? [...state.devices].sort((a, b) => {
        const audio = Number(isAudio(b.cod)) - Number(isAudio(a.cod));
        if (audio !== 0) return audio;
        const rssi = (b.rssi ?? -999) - (a.rssi ?? -999);
        if (rssi !== 0) return rssi;
        return (a.name ?? a.mac).localeCompare(b.name ?? b.mac);
      })
    : [];

  const scanMessage = {
    idle: "",
    queued: "Waiting for the speaker to check in — this can take up to a minute.",
    scanning: "Scanning now. Put your speaker in pairing mode.",
    done: "Scan finished.",
  }[scanState];

  return (
    <Section title="Speaker output">
      {error && <div className="banner is-bad">{error}</div>}

      {!state ? (
        <Spinner />
      ) : (
        <>
          <div className="rows" style={{ marginBottom: 14 }}>
            <div className="row">
              <span className="row-main">
                <span className="row-title">Playing through</span>
                <span className="row-sub">
                  {outputLabel(state)}
                  {state.relay_error ? ` · ${state.relay_error}` : ""}
                </span>
              </span>
              {state.selected ? (
                <button
                  className="btn-quiet"
                  disabled={busy}
                  onClick={() => choose(null, null)}
                >
                  Use wired output
                </button>
              ) : null}
            </div>
          </div>

          <p className="t-sub" style={{ marginBottom: 10 }}>
            Press <strong>Scan</strong>, wait for it to say it's scanning, and{" "}
            <em>then</em> put your speaker into pairing mode. The speaker checks
            in about once a minute, so the first press can take that long to
            start.
          </p>

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
            <button className="btn" disabled={busy} onClick={scan}>
              {scanState === "queued" || scanState === "scanning"
                ? "Scanning…"
                : "Scan for speakers"}
            </button>
            {scanMessage && <span className="t-sub">{scanMessage}</span>}
          </div>

          {sorted.length === 0 ? (
            <div className="empty">
              <p className="empty-title">No devices found yet</p>
              Run a scan with your speaker switched on and in pairing mode.
            </div>
          ) : (
            <div className="rows">
              {sorted.map((d) => {
                const chosen = state.selected === d.mac;
                return (
                  <div key={d.mac} className="row">
                    <span className="row-main">
                      <span className="row-title">{d.name ?? d.mac}</span>
                      <span className="row-sub">
                        {isAudio(d.cod) ? "Audio device" : "Other device"}
                        {d.name ? ` · ${d.mac}` : ""}
                        {chosen
                          ? state.relay_connected
                            ? " · connected"
                            : " · selected, not connected"
                          : ""}
                      </span>
                    </span>
                    <button
                      className={chosen ? "btn-quiet" : "btn"}
                      disabled={busy || chosen}
                      onClick={() => choose(d.mac, d.name)}
                    >
                      {chosen ? "In use" : "Use this one"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Section>
  );
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
function Speaker({ call }: { call: Call }) {
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
    { cmd: "report-full", label: "Check it", sub: "Full diagnostic. Safe while music is playing." },
    { cmd: "run-repair", label: "Try to fix it", sub: "Restarts Bluetooth and the services. Stops the music." , danger: true },
    { cmd: "restart-listener", label: "Restart the app", sub: "Just the listener. Usually enough.", danger: true },
    { cmd: "reboot", label: "Reboot the box", sub: "Last resort. About a minute offline.", danger: true },
  ];

  const send = async (cmd: string, label: string) => {
    if (cmd !== "report-full") {
      const ok = await confirm({
        title: `${label}?`,
        body:
          cmd === "reboot"
            ? "Music stops for about a minute, and whoever is DJing is cut off."
            : cmd === "run-repair"
              ? "Restarts Bluetooth and the lockerroom services. Music stops if anything is playing, and the speaker can show as offline for a few minutes. It will not touch the listener's code."
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
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not queue that");
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(() => {
    call<{ commands: PiCommand[]; allowed: string[] }>("/api/admin/pi/commands")
      .then((r) => setCommands(r.commands))
      .catch(() => setCommands([]));
    // Separate request because it is separate storage. A failure here must not
    // blank the command list — the buttons are the half you need when the box
    // is misbehaving.
    call<{ reports: PiReport[] }>("/api/admin/pi/reports")
      .then((r) => setReports(r.reports ?? []))
      .catch(() => setReports([]));
  }, [call]);

  useEffect(load, [load]);

  const label = (c: PiCommand) =>
    c.completed_at ? (c.ok ? "done" : "failed") : c.dispatched_at ? "running" : "queued";

  return (
    <Section title="Diagnostics">
      {dialog}
      {error && <div className="banner is-bad">{error}</div>}
      {sent && <div className="banner is-info">{sent}</div>}
      <p className="t-sub" style={{ marginBottom: 12 }}>
        Check the box, try to fix it, and read what it sent back. It checks in
        about once a minute, so a result can take that long to appear.
      </p>

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
                    <span className="row-title">{c.command.replace(/-/g, " ")}</span>
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
              {r.kind === "run-repair" ? "Repair log" : "Full report"}
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
