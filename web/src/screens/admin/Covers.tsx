import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./../../api";
import { Fold as Section, Banner, artworkSrc } from "./../../components";
import type { Call } from "./adminApi";

interface CoverStatus {
  found: number;
  none: number;
  pending: number;
  samples: { title: string; url: string }[];
}

/**
 * Loads one stored cover on THIS phone, on THIS network, and says whether it
 * arrived. If covers are stored but these fail, the server is fine and the
 * network is blocking the image host — something no server log can show.
 */
function CoverProbe({ title, url }: { title: string; url: string }) {
  const [state, setState] = useState<"loading" | "ok" | "blocked">("loading");
  // The same cover through our own server, which is how the app loads it
  // now. Direct-blocked but via-AuxGoat-loads is the campus filter, fixed.
  const [proxied, setProxied] = useState<"loading" | "ok" | "blocked">("loading");
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  return (
    <div className="row">
      <img
        src={url}
        alt=""
        width={40}
        height={40}
        style={{ borderRadius: 6, objectFit: "cover", flexShrink: 0, background: "var(--hairline)" }}
        onLoad={() => setState("ok")}
        onError={() => setState("blocked")}
      />
      <img
        src={artworkSrc(url)}
        alt=""
        width={1}
        height={1}
        style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
        onLoad={() => setProxied("ok")}
        onError={() => setProxied("blocked")}
      />
      <span className="row-main">
        <span className="row-title">{title}</span>
        <span className="row-sub">
          {state === "loading"
            ? `Loading from ${host}…`
            : state === "ok"
              ? `Loads on this phone · ${host}`
              : `Could not load on this network · ${host}`}
        </span>
        <span className="row-sub">
          {proxied === "loading"
            ? "Through AuxGoat: loading…"
            : proxied === "ok"
              ? "Through AuxGoat: loads (this is what players see)"
              : "Through AuxGoat: failed too"}
        </span>
      </span>
    </div>
  );
}

interface RetryResult {
  retried: number;
  found: number;
  remaining: number;
  next_offset: number;
  failures: { title: string; artist: string | null; why: string[] }[];
}

/**
 * Album covers that came back as a colour block.
 *
 * The retry endpoint existed since 2026-08-05 but had no button, so the only
 * way to heal a missing cover was curl. And it answered with a count, which
 * on 2026-09-27 — every song a colour block — could not say whether Deezer
 * refused, iTunes refused, or both answered and the matcher said no. It shows
 * the reason now, per song, because the reason IS the diagnosis.
 *
 * Batched server-side (a Worker has a cap on outbound fetches per request),
 * so "Next batch" carries the cursor the last answer handed back.
 */
export function Covers({ call }: { call: Call }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RetryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CoverStatus | null>(null);

  const loadStatus = useCallback(() => {
    call<CoverStatus>("/api/admin/artwork/status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [call]);
  useEffect(loadStatus, [loadStatus]);

  const run = async (offset: number) => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await call<RetryResult>("/api/admin/artwork/retry", {
          method: "POST",
          body: JSON.stringify({ offset }),
        }),
      );
    } catch (e) {
      setError(errorMessage(e, "Could not retry covers"));
    } finally {
      setBusy(false);
      loadStatus();
    }
  };

  return (
    <Section title="Album covers">
      {error && <Banner kind="bad">{error}</Banner>}
      {status && (
        <p className="t-sub" style={{ marginBottom: 12 }}>
          {status.found} with a cover · {status.none} without
          {status.pending ? ` · ${status.pending} never looked up` : ""}
        </p>
      )}
      {status && status.samples.length > 0 && (
        <div className="rows" style={{ marginBottom: 12 }}>
          {status.samples.map((s) => (
            <CoverProbe key={s.url} title={s.title} url={s.url} />
          ))}
        </div>
      )}
      <div className="rows" style={{ marginBottom: result ? 12 : 0 }}>
        <div className="row">
          <span className="row-main">
            <span className="row-title">Find missing covers</span>
            <span className="row-sub">
              Looks up songs showing a colour block again. Safe any time.
            </span>
          </span>
          <button className="btn" disabled={busy} onClick={() => run(0)}>
            {busy ? "Looking…" : "Run"}
          </button>
        </div>
      </div>

      {result && (
        <>
          <p className="t-sub" style={{ marginBottom: 8 }}>
            {result.retried === 0
              ? "No songs are missing a cover."
              : `Tried ${result.retried}, found ${result.found}.` +
                (result.remaining ? ` ${result.remaining} more to try.` : "")}
          </p>
          {result.failures.length > 0 && (
            <div className="rows">
              {result.failures.map((f, i) => (
                <div key={i} className="row">
                  <span className="row-main">
                    <span className="row-title">{f.title}</span>
                    <span className="row-sub">
                      {f.artist ?? "Unknown artist"} · {f.why.join(" · ")}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {result.remaining > 0 && (
            <button
              className="btn-quiet"
              disabled={busy}
              onClick={() => run(result.next_offset)}
              style={{ marginTop: 8 }}
            >
              Next batch
            </button>
          )}
        </>
      )}
    </Section>
  );
}
