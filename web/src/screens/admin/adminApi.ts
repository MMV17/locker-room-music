import { useCallback } from "react";
import { ApiError } from "./../../api";

/**
 * Coach-facing. Gated by its own password rather than the team session — a
 * coach setting up the roster has no reason to have joined as a player first.
 *
 * The password is held in sessionStorage, not localStorage: it closes with
 * the tab, which is the right default for a credential that gates roster
 * edits and voiding.
 */

export const PW_KEY = "lr_admin_pw";

/**
 * Every Admin request: the admin password as a header, the team session
 * cookie along for the ride. Deliberately NOT api.ts request(): a 401 here
 * means a wrong admin password, and request() treats any 401 as the player's
 * session ending and signs them out.
 */
export type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

export function useAdminCall(pw: string): Call {
  return useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const res = await fetch(path, {
        credentials: "same-origin",
        ...init,
        headers: {
          "X-Admin-Password": pw,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, (body as any).error ?? "Something went wrong");
      return body as T;
    },
    [pw],
  );
}
