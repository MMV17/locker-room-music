import { useCallback, useEffect, useState } from "react";
import { ApiError, errorMessage } from "./../../api";
import { Fold as Section, Banner, Spinner, useConfirm } from "./../../components";
import type { AdminUser } from "./types";
import type { Call } from "./adminApi";

export function Roster({ call }: { call: Call }) {
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
    } catch (e) {
      // Only a 409 is a duplicate. A 400 carries the server's reason (an
      // invalid name or number); anything else is just a failure.
      setError(
        e instanceof ApiError && e.status === 409
          ? "That player already exists."
          : e instanceof ApiError && e.status === 400
            ? e.message
            : "Could not add that player.",
      );
    }
  };

  const toggle = async (u: AdminUser) => {
    setError(null);
    try {
      await call(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !u.active }),
      });
      load();
    } catch (e) {
      setError(errorMessage(e, u.active ? "Could not deactivate that player" : "Could not restore that player"));
    }
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
      setError(errorMessage(e, "Could not delete that player"));
    }
  };

  return (
    <Section title="Roster">
      {dialog}
      {error && <Banner kind="bad">{error}</Banner>}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          className="input"
          placeholder="First name"
          aria-label="First name"
          value={first}
          onChange={(e) => setFirst(e.target.value)}
        />
        <input
          className="input"
          placeholder="Last name"
          aria-label="Last name"
          value={last}
          onChange={(e) => setLast(e.target.value)}
        />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          className="input"
          placeholder="#"
          aria-label="Jersey number (optional)"
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
              <span className="jersey is-sm" aria-hidden="true">
                {u.jersey_number || u.name[0]}
              </span>
              <span className="row-main">
                {/* A colour, not opacity: half-opacity text failed contrast,
                    and the word says it for anyone who cannot see either. */}
                <span className={"row-title" + (u.active ? "" : " is-inactive")}>{u.name}</span>
                <span className="row-sub">
                  #{u.jersey_number ?? "—"}
                  {!u.active && " (deactivated)"}
                </span>
              </span>
              {/* Grouped so the row's 14px gap falls once, before the pair,
                  rather than between two already-padded buttons — the name
                  needs that width back on a phone. */}
              <span className="row-actions">
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
