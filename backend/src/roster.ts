import { normalize } from "./trackKey";

/**
 * The roster identity key: normalize(first)|normalize(last)|normalize(jersey).
 *
 * UNIQUE in the schema, and it is what makes a re-signup — cleared cookies, a
 * new phone, a reinstalled browser — find an existing player instead of
 * creating a second row and splitting their play history. Every writer of it
 * calls THIS: signup, the admin rename and PATCH /api/me.
 */
export const identityKey = (first: string, last: string, jersey: string | null) =>
  `${normalize(first)}|${normalize(last)}|${normalize(jersey ?? "")}`;

/** Names are rendered on every screen and on the boards, so they are bounded. */
export const MAX_NAME_LENGTH = 40;
const JERSEY = /^[0-9]{1,3}$/;

/**
 * Why this name and number cannot be saved, or null when they can. The one
 * rule for signup, PATCH /api/me and the admin create/edit - signup used to
 * accept a 5,000-character name and a jersey of "abcdefgh".
 *
 * Takes the TRIMMED values. An empty jersey is fine (stored as null).
 */
export function identityProblem(first: string, last: string, jersey: string | null): string | null {
  if (!first || !last) return "First and last name are required";
  if (first.length > MAX_NAME_LENGTH || last.length > MAX_NAME_LENGTH) return "That name is too long";
  if (jersey && !JERSEY.test(jersey)) return "A jersey number is up to three digits";
  return null;
}

/** A string field from a JSON body, trimmed; anything else reads as "". */
export const textField = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Whether a D1 error is the users.identity_key UNIQUE constraint. */
export function isIdentityClash(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));
}
