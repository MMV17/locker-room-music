/**
 * Request-shape helpers shared by every route module.
 */
import type { Context } from "hono";

/**
 * The JSON body as an object, or null when it is malformed, missing, or not an
 * object (an array, a string, `null`). Callers answer null with badJson().
 *
 * A bare `c.req.json()` throws on a malformed body, and the throw used to reach
 * onError as a 500 - which tells a client its request was fine and the server
 * broke, the opposite of the truth.
 */
export async function readJson<T extends object = Record<string, unknown>>(
  c: Context<any>,
): Promise<T | null> {
  try {
    const body: unknown = await c.req.json();
    return isPlainObject(body) ? (body as T) : null;
  } catch {
    return null;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function badJson(c: Context<any>) {
  return c.json({ error: "The request body must be a JSON object" }, 400);
}
