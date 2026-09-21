import { Hono } from "hono";
import type { Env } from "./types";

export const devices = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/**
 * Devices seen playing that nobody has claimed yet. The mac_hint (last two
 * octets) is all anyone needs to recognise their own phone.
 */
devices.get("/api/devices/unclaimed", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.mac_hash, d.mac_hint, d.alias, d.first_seen,
            COUNT(p.id) AS plays
     FROM devices d
     LEFT JOIN plays p ON p.device_hash = d.mac_hash
     WHERE d.user_id IS NULL
     GROUP BY d.mac_hash
     ORDER BY plays DESC`,
  ).all();
  return c.json({ devices: results });
});

/**
 * Claim a device. Backfills the denormalized user_id onto that device's
 * existing plays, so a DJ gets credit for songs played before they claimed.
 *
 * Note this is first-tap-wins: any signed-in user can claim any unclaimed
 * device and inherit its whole history. There is no proof of possession. The
 * mitigations are social - the UI names the device and the number of songs it
 * is about to credit, and an admin can un-claim (admin.ts). If it is ever
 * abused, dropping the backfill below removes the incentive.
 */
devices.post("/api/devices/:hash/claim", async (c) => {
  const userId = c.get("userId");
  const hash = c.req.param("hash");

  const device = await c.env.DB.prepare(
    "SELECT mac_hash, user_id FROM devices WHERE mac_hash = ?",
  )
    .bind(hash)
    .first<{ mac_hash: string; user_id: string | null }>();
  if (!device) return c.json({ error: "Unknown device" }, 404);
  if (device.user_id) return c.json({ error: "Device already claimed" }, 409);

  /* The read above is a courtesy - it is what turns an unknown phone into a 404
     and an already-claimed one into a friendly 409. It is NOT the thing that
     decides the claim, because between that read and the write another tap can
     land. `AND user_id IS NULL` is what actually settles it: SQLite applies the
     condition and the write as one statement, so of any number of simultaneous
     claims exactly one reports a changed row.

     This must stay OUTSIDE the batch below. A batch is one transaction, but its
     later statements run whether or not this one matched anything - so a loser
     would still have backfilled the play history to itself, which is precisely
     the corruption being fixed: the phone ends up owned by one player with its
     songs credited to another. */
  const claim = await c.env.DB.prepare(
    "UPDATE devices SET user_id = ?, claimed_at = ? WHERE mac_hash = ? AND user_id IS NULL",
  )
    .bind(userId, new Date().toISOString(), hash)
    .run();
  if (!claim.meta.changes) {
    // Lost the race. Somebody else owns the phone now.
    return c.json({ error: "Device already claimed" }, 409);
  }

  /* Now that ownership is settled, credit the history to the winner. Not in the
     same transaction as the claim any more, which is the deliberate trade: if
     the Worker dies between the two, the phone is claimed with its old songs
     left unattributed - visible, harmless, and fixable with an admin unclaim
     and re-claim. The alternative was crediting them to the wrong player. */
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE plays SET user_id = ? WHERE device_hash = ? AND user_id IS NULL",
    ).bind(userId, hash),
    // The backfill can retroactively make you the DJ of a song you already
    // voted on, back when the device was unclaimed and nobody knew it was
    // yours. Void those votes so "a DJ never rates their own song" stays true
    // rather than nearly true.
    c.env.DB.prepare(
      `UPDATE votes SET voided = 1
       WHERE user_id = ?
         AND play_id IN (SELECT id FROM plays WHERE device_hash = ?)`,
    ).bind(userId, hash),
  ]);

  return c.json({ ok: true });
});
