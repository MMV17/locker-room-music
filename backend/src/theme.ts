import { Hono } from "hono";
import type { Env } from "./types";

export const theme = new Hono<{ Bindings: Env }>();

export const DEFAULT_TEAM_NAME = "Locker Room";

/*
 * THERE IS NO TEAM COLOUR ANY MORE.
 *
 * This endpoint used to serve `primary`, a per-school hex the admin picked,
 * which the client turned into four CSS custom properties. The palette is now
 * fixed to the AuxGoat logo - black, ivory, antique gold - so a school is
 * named here and nothing else. See the token block in web/src/styles.css.
 *
 * The `theme_primary` settings row is deliberately NOT deleted: it costs one
 * unread row, and dropping stored state on a deploy is the kind of thing that
 * is only ever noticed when you want it back. Nothing reads it.
 *
 * The hex validator went with it. If a colour ever returns, the note it
 * carried is worth restoring too: the value was written into a CSS custom
 * property on every page, so an unvalidated string here was a stylesheet
 * injection into the whole site.
 */

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
  const teamName = await getSetting(c.env, "team_name");
  return c.json(
    {
      team_name: teamName ?? DEFAULT_TEAM_NAME,
    },
    200,
    { "Cache-Control": "public, max-age=60" },
  );
});

/**
 * Admin-gated by the requireAdmin middleware mounted on /api/admin/* .
 *
 * A `primary` in the body is now IGNORED rather than rejected: an admin tab
 * left open across the deploy will still send one, and 400-ing a rename over
 * a field nobody can see is a worse outcome than quietly dropping it.
 */
theme.put("/api/admin/theme", async (c) => {
  type Body = { team_name?: string };
  const body: Body = await c.req.json<Body>().catch(() => ({}) as Body);

  if (body.team_name !== undefined) {
    const name = String(body.team_name).trim().slice(0, 60);
    if (!name) return c.json({ error: "Team name can't be empty" }, 400);
    await putSetting(c.env, "team_name", name);
  }

  const teamName = await getSetting(c.env, "team_name");
  return c.json({ ok: true, team_name: teamName ?? DEFAULT_TEAM_NAME });
});
