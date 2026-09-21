import { describe, it, expect } from "vitest";
import { activeSessionUserId } from "../src/session";

/**
 * Which token rows are still allowed to act.
 *
 * The bug this exists for, found 2026-09-08: requireSession looked up
 * device_tokens and nothing else. `PATCH /api/admin/users/:id` with
 * `active: false` sets users.active = 0 and touches no tokens, so a player an
 * admin had just deactivated kept a working session and could keep voting
 * until they signed out on their own. Only the SIGN-IN path checked the flag.
 *
 * Deleting a player was never affected - that path explicitly deletes their
 * device_tokens, with a comment saying why. Deactivating simply never got the
 * same treatment, and deactivating is the one an admin reaches for mid-season.
 *
 * The rule is a property of the row, so it lives here where it can be tested,
 * rather than being implied by the shape of a SQL query.
 */
describe("activeSessionUserId", () => {
  it("admits an active player's token", () => {
    expect(activeSessionUserId({ user_id: "u1", active: 1 })).toBe("u1");
  });

  it("rejects a token whose player has been deactivated", () => {
    // The whole point. This token is valid, unexpired and in the table.
    expect(activeSessionUserId({ user_id: "u1", active: 0 })).toBeNull();
  });

  it("rejects an unknown token", () => {
    expect(activeSessionUserId(null)).toBeNull();
  });

  it("rejects a token whose player row has gone missing", () => {
    // A LEFT JOIN that found no user yields a null flag. Deletion already
    // removes the tokens, so this is the belt to that braces - but a token
    // pointing at nothing must never be treated as a live session.
    expect(activeSessionUserId({ user_id: "u1", active: null })).toBeNull();
  });
});
