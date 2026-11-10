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
