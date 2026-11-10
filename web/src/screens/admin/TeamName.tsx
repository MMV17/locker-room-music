import { useEffect, useState } from "react";
import { errorMessage } from "./../../api";
import { Fold as Section, Banner } from "./../../components";
import { cacheTheme } from "./../../theme";
import type { Theme } from "./../../theme";
import type { Call } from "./adminApi";

/**
 * The team's name. That is the whole of it now.
 *
 * There used to be a colour picker here, and one hex drove the entire brand:
 * the tab underline, jersey numbers, buttons. It is gone, and so is
 * `theme.primary` — the palette is fixed to the logo's black, ivory and
 * antique gold. A school is named, not coloured. See styles.css.
 */
export function Appearance({ call }: { call: Call }) {
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
      setError(errorMessage(e, "Could not save"));
    }
  };

  return (
    <Section title="Team">
      {error && <Banner kind="bad">{error}</Banner>}
      {saved && <Banner kind="ok">Saved.</Banner>}

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
