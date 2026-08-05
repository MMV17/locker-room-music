/**
 * Raw MAC addresses never leave the Pi and are never stored here
 * (spec non-negotiable #3). The server keeps a salted hash plus a
 * two-octet hint, which is enough for someone to recognise their own
 * device in the claim list and nothing more.
 */

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase().replace(/-/g, ":");
}

export async function hashMac(mac: string, salt: string): Promise<string> {
  return sha256Hex(normalizeMac(mac) + salt);
}

/** Last two octets, for human identification only. */
export function macHint(mac: string): string {
  const parts = normalizeMac(mac).split(":");
  return parts.slice(-2).join(":");
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fold a typed team code to the shape we compare on.
 *
 * The team code is not a password. It is a word the whole team already knows,
 * typed once, on a phone, in a locker room — and it is the ONLY gate, so a
 * player who cannot get past it cannot use the product at all. Case
 * sensitivity defends nothing here (anyone guessing "crusaders" guesses
 * "CRUSADERS" on the next try) and reliably locks someone out, because
 * `autoCapitalize="characters"` is only an iOS keyboard hint: it does nothing
 * on desktop, nothing on paste, and nothing on many third-party keyboards.
 *
 * Deliberately NOT applied to DEVICE_KEY or ADMIN_PASSWORD. Those are real
 * secrets, machine-entered or typed once by one person, and they stay exact.
 *
 * Internal whitespace is left alone on purpose — "CRUS ADERS" is a typo, not a
 * formatting artifact, and silently accepting it would make the error message
 * lie about what went wrong.
 */
export function normalizeTeamCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Constant-time-ish comparison, to avoid leaking secrets by timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Stable colour derived from the track key, used when artwork lookup finds
 * nothing. No broken images, no placeholder icons (spec 6.4).
 */
export function fallbackColor(trackKey: string): string {
  let h = 0;
  for (let i = 0; i < trackKey.length; i++) {
    h = (h * 31 + trackKey.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue} 45% 38%)`;
}
