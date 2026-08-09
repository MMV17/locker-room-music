import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./../api";
import { Spinner, formatWhen } from "./../components";
import { useNavigate } from "./../router";
import { applyTheme, cacheTheme } from "./../theme";
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

      <Appearance call={call} />
      <Roster call={call} />
      <Speaker call={call} />
      <Devices call={call} />
      <Plays call={call} />
    </main>
  );
}

type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * The one team colour. Everything else on the site is neutral, so this single
 * value is the whole brand — and because it is only ever used as an accent,
 * any school colour is safe here, including ones that would be unreadable as
 * a background.
 */
function Appearance({ call }: { call: Call }) {
  const [primary, setPrimary] = useState("#2f3a45");
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/theme")
      .then((r) => r.json())
      .then((t: Theme) => {
        setPrimary(t.primary);
        setName(t.team_name);
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setError(null);
    try {
      const t = await call<Theme & { ok: true }>("/api/admin/theme", {
        method: "PUT",
        body: JSON.stringify({ primary, team_name: name }),
      });
      applyTheme(t);
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

      <label className="field">
        <span className="t-label">Team color</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            type="color"
            value={primary}
            onChange={(e) => {
              setPrimary(e.target.value);
              // Live preview, so a school colour can be matched by eye.
              applyTheme({ primary: e.target.value, team_name: name });
            }}
            style={{
              width: 56,
              height: 52,
              padding: 4,
              border: "1px solid var(--hairline)",
              borderRadius: 16,
              background: "var(--surface)",
            }}
            aria-label="Team color"
          />
          <input
            className="input"
            value={primary}
            onChange={(e) => setPrimary(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
          />
        </div>
      </label>

      <p className="t-sub" style={{ marginBottom: 12 }}>
        Used for accents only — the tab underline, jersey numbers, buttons. Thumbs stay
        green and red whatever you pick.
      </p>

      <button className="btn is-primary is-block" onClick={save}>
        Save
      </button>
    </Section>
  );
}

function Roster({ call }: { call: Call }) {
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
    if (!window.confirm(`Delete ${u.name}? ${kept}${lost}. This cannot be undone.`)) return;
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
    if (!window.confirm(`Delete ${name}? ${cost} It comes back if that phone plays again.`)) {
      return;
    }
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
function Plays({ call }: { call: Call }) {
  const [plays, setPlays] = useState<AdminPlay[] | null>(null);

  const load = useCallback(() => {
    call<{ plays: AdminPlay[] }>("/api/admin/plays")
      .then((r) => setPlays(r.plays))
      .catch(() => setPlays([]));
  }, [call]);

  useEffect(load, [load]);

  const voidPlay = async (p: AdminPlay) => {
    if (!window.confirm(`Void "${p.title}"? It stops counting toward every ranking.`)) return;
    await call(`/api/admin/plays/${p.id}/void`, { method: "POST" });
    load();
  };

  return (
    <Section title="Recent plays">
      {!plays ? (
        <Spinner />
      ) : plays.length === 0 ? (
        <p className="t-sub">Nothing has played yet.</p>
      ) : (
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
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 30 }}>
      <h2 className="t-section" style={{ marginBottom: 12 }}>
        {title}
      </h2>
      {children}
    </section>
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
  const [allowed, setAllowed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    call<{ commands: PiCommand[]; allowed: string[] }>("/api/admin/pi/commands")
      .then((r) => {
        setCommands(r.commands);
        setAllowed(r.allowed);
      })
      .catch(() => setCommands([]));
  }, [call]);

  useEffect(load, [load]);

  const send = async (command: string) => {
    // Reboot cuts audio for whoever is DJing right now.
    if (command === "reboot" && !confirm("Reboot the speaker? Music stops for about a minute.")) return;
    setBusy(true);
    setError(null);
    try {
      await call("/api/admin/pi/commands", {
        method: "POST",
        body: JSON.stringify({ command }),
      });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not queue that");
    } finally {
      setBusy(false);
    }
  };

  const label = (c: PiCommand) =>
    c.completed_at ? (c.ok ? "done" : "failed") : c.dispatched_at ? "running" : "queued";

  return (
    <Section title="Speaker">
      {error && <div className="banner is-bad">{error}</div>}
      <p className="t-sub" style={{ marginBottom: 12 }}>
        The speaker checks in about once a minute, so a command can take that long to
        start.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {allowed.map((cmd) => (
          <button
            key={cmd}
            className="btn"
            disabled={busy}
            onClick={() => send(cmd)}
          >
            {cmd.replace(/-/g, " ")}
          </button>
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
          {commands.slice(0, 6).map((c) => (
            <div key={c.id} className="row">
              <span className="row-main">
                <span className="row-title">{c.command.replace(/-/g, " ")}</span>
                <span className="row-sub">
                  {label(c)} · {formatWhen(c.created_at)}
                  {c.result ? ` · ${c.result.split("\n")[0].slice(0, 40)}` : ""}
                </span>
              </span>
              <button className="btn-quiet" onClick={load}>
                Refresh
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
