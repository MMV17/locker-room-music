import { Hono } from "hono";
import type { Env } from "./types";

export const theme = new Hono<{ Bindings: Env }>();

/**
 * Until an admin sets one, a restrained neutral. Deliberately not a guess at
 * anyone's school colours - a wrong team colour looks worse than no team
 * colour, and spec 9.2 asks for a palette that does not assume one team.
 */
export const DEFAULT_PRIMARY = "#2F3A45";
export const DEFAULT_TEAM_NAME = "Locker Room";

/** Six-digit hex only. See the validation note in the PUT handler. */
const HEX = /^#[0-9a-f]{6}$/i;

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, new Date().toISOString())
    .run();
}

/**
 * Unauthenticated on purpose: the join screen renders before any session
 * exists and should already be in team colours. Nothing here is sensitive -
 * it is a colour and a name that appear on every page anyway.
 */
theme.get("/api/theme", async (c) => {
  const [primary, teamName] = await Promise.all([
    getSetting(c.env, "theme_primary"),
    getSetting(c.env, "team_name"),
  ]);
  return c.json(
    {
      primary: primary ?? DEFAULT_PRIMARY,
      team_name: teamName ?? DEFAULT_TEAM_NAME,
    },
    200,
    { "Cache-Control": "public, max-age=60" },
  );
});

/**
 * Admin-gated by the requireAdmin middleware mounted on /api/admin/* .
 *
 * The hex check is not cosmetic. This value is written into a CSS custom
 * property on every page, so an unvalidated string here is a stylesheet
 * injection into the whole site. Reject anything that is not exactly
 * #rrggbb - including named colours and three-digit shorthand, both of which
 * are valid CSS and neither of which is worth widening the gate for.
 */
theme.put("/api/admin/theme", async (c) => {
  type Body = { primary?: string; team_name?: string };
  const body: Body = await c.req.json<Body>().catch(() => ({}) as Body);

  if (body.primary !== undefined) {
    if (typeof body.primary !== "string" || !HEX.test(body.primary)) {
      return c.json({ error: "Color must be a six-digit hex, like #862633" }, 400);
    }
    await putSetting(c.env, "theme_primary", body.primary.toLowerCase());
  }

  if (body.team_name !== undefined) {
    const name = String(body.team_name).trim().slice(0, 60);
    if (!name) return c.json({ error: "Team name can't be empty" }, 400);
    await putSetting(c.env, "team_name", name);
  }

  const [primary, teamName] = await Promise.all([
    getSetting(c.env, "theme_primary"),
    getSetting(c.env, "team_name"),
  ]);
  return c.json({
    ok: true,
    primary: primary ?? DEFAULT_PRIMARY,
    team_name: teamName ?? DEFAULT_TEAM_NAME,
  });
});
