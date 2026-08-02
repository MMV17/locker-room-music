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
