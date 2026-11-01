import { afterEach, describe, it, expect, vi } from "vitest";
import { lookupArtwork, mbCandidates, plainQuery, pick } from "../src/artwork";
import type { Env } from "../src/types";

/**
 * These are drawn from real catalogue data, not invented. The artist filter
 * exists to keep karaoke and tribute records from becoming a song's cover, so
 * every loosening has to be checked against that.
 */

const ART = "https://example.test/cover.jpg";

describe("pick", () => {
  it("matches when the catalogue adds a leading 'The'", () => {
    // The real failure: AVRCP said "Black Eyed Peas", Deezer says "The Black
    // Eyed Peas", and all four correct results were discarded.
    const candidates = [
      { artist: "The Black Eyed Peas", album: "THE E.N.D.", art: ART },
    ];
    expect(pick(candidates, "Black Eyed Peas", "THE E.N.D.")).toBe(ART);
  });

  it("matches when the phone adds the leading 'The' instead", () => {
    const candidates = [{ artist: "Weeknd", album: "After Hours", art: ART }];
    expect(pick(candidates, "The Weeknd", "After Hours")).toBe(ART);
  });

  it("matches when the phone lists collaborators and the catalogue does not", () => {
    // AVRCP sends every credited artist comma-joined; Deezer files the track
    // under the lead. Both of these showed a colour block in production.
    expect(
      pick([{ artist: "Travis Scott", album: "Rodeo", art: ART }],
        "Travis Scott, Kacy Hill", "Rodeo"),
    ).toBe(ART);
    expect(
      pick([{ artist: "Kanye West", album: "Graduation", art: ART }],
        "Kanye West, Chris Martin", "Graduation"),
    ).toBe(ART);
  });

  it("keeps an artist whose real name contains a separator", () => {
    // The reduction is applied to both sides, so these still match themselves.
    expect(
      pick([{ artist: "Simon & Garfunkel", album: "Bookends", art: ART }],
        "Simon & Garfunkel", "Bookends"),
    ).toBe(ART);
    expect(
      pick([{ artist: "Earth, Wind & Fire", album: "That's the Way of the World", art: ART }],
        "Earth, Wind & Fire", "That's the Way of the World"),
    ).toBe(ART);
  });

  it("prefers an exact artist match over a lead-artist one", () => {
    const exact = "https://example.test/exact.jpg";
    const candidates = [
      { artist: "Travis Scott", album: "Rodeo", art: ART },
      { artist: "Travis Scott, Kacy Hill", album: "Rodeo", art: exact },
    ];
    // Precision is not traded away when it was actually available.
    expect(pick(candidates, "Travis Scott, Kacy Hill", "Rodeo")).toBe(exact);
  });

  it("still refuses a karaoke record", () => {
    // The reason the artist filter is there at all.
    const candidates = [
      { artist: "Lullaby Versions of Paramore", album: "Decode", art: ART },
      { artist: "Karaoke Night", album: "Decode", art: ART },
    ];
    expect(pick(candidates, "Paramore", "Decode")).toBeNull();
  });

  it("does not let the article rule collapse different artists", () => {
    // "The Band" and "Band of Horses" must not become the same thing.
    const candidates = [{ artist: "Band of Horses", album: "Infinite Arms", art: ART }];
    expect(pick(candidates, "The Band", "Music from Big Pink")).toBeNull();
  });

  it("prefers the release whose album matches the phone", () => {
    const soundtrack = "https://example.test/soundtrack.jpg";
    const candidates = [
      { artist: "Paramore", album: "Twilight Soundtrack", art: soundtrack },
      { artist: "Paramore", album: "Decode", art: ART },
    ];
    expect(pick(candidates, "Paramore", "Decode")).toBe(ART);
  });

  it("falls back to provider ranking when no album matches", () => {
    const candidates = [
      { artist: "Paramore", album: "Some Compilation", art: ART },
    ];
    expect(pick(candidates, "Paramore", "Decode")).toBe(ART);
  });

  it("returns null rather than a candidate with no artwork", () => {
    const candidates = [{ artist: "Paramore", album: "Decode", art: null }];
    expect(pick(candidates, "Paramore", "Decode")).toBeNull();
  });

  it("is case and punctuation insensitive", () => {
    const candidates = [{ artist: "AC/DC", album: "Back in Black", art: ART }];
    expect(pick(candidates, "acdc", "back in black")).toBe(ART);
  });
});

/**
 * Every miss has to say why. On 2026-09-27 every song was a colour block and
 * nothing could tell a provider refusal from a matcher rejection.
 */
describe("lookupArtwork reasons", () => {
  const writes: unknown[][] = [];
  const env = {
    DB: {
      prepare: () => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            writes.push(args);
          },
        }),
      }),
    },
  } as unknown as Env;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  afterEach(() => {
    vi.unstubAllGlobals();
    writes.length = 0;
  });

  it("reads Deezer's HTTP-200 error body as a refusal, not as no results", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("deezer")
        ? json({ error: { type: "Exception", message: "Quota limit exceeded", code: 4 } })
        : json({}, 403),
    );
    const r = await lookupArtwork(env, "t1", "Decode", "Paramore", null);
    expect(r.url).toBeNull();
    expect(r.why).toContain("deezer: Quota limit exceeded (code 4)");
    expect(r.why).toContain("itunes: HTTP 403");
    expect(writes[0]).toEqual([null, "none", "t1"]);
  });

  it("reports a thrown fetch with its message", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Too many subrequests.");
    });
    const r = await lookupArtwork(env, "t1", "Decode", "Paramore", null);
    expect(r.why).toEqual([
      "deezer: Too many subrequests.",
      "itunes: Too many subrequests.",
      "musicbrainz: Too many subrequests.",
    ]);
  });

  it("names the artists it rejected", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("deezer")
        ? json({ data: [{ artist: { name: "Lullaby Versions of Paramore" }, album: { title: "X", cover_big: ART } }] })
        : json({ results: [] }),
    );
    const r = await lookupArtwork(env, "t1", "Decode", "Paramore", null);
    expect(r.why).toEqual([
      'deezer: 1 results, none matched artist "Paramore" (got Lullaby Versions of Paramore)',
      "itunes: 0 results",
      "musicbrainz: 0 results",
    ]);
  });

  it("returns the cover and records it as found", async () => {
    vi.stubGlobal("fetch", async () =>
      json({ data: [{ artist: { name: "Paramore" }, album: { title: "Decode", cover_big: ART } }] }),
    );
    const r = await lookupArtwork(env, "t1", "Decode", "Paramore", "Decode");
    expect(r).toEqual({ url: ART, why: [] });
    expect(writes[0]).toEqual([ART, "found", "t1"]);
  });
});

/**
 * 2026-11-01: Deezer answers every field-scoped query (artist:"X" track:"Y")
 * with {"data":[],"total":0}, from any network, while the same words as plain
 * text find the song. That is why every cover went blank. These pin the fix.
 */
describe("the Deezer query", () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = {
    DB: { prepare: () => ({ bind: () => ({ run: async () => {} }) }) },
  } as unknown as Env;

  it("never sends Deezer's dead field syntax", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await lookupArtwork(env, "t1", "Sex on Fire", "Kings of Leon", "Only By the Night");
    const deezer = urls.filter((u) => u.includes("api.deezer.com")).map((u) => decodeURIComponent(u));
    expect(deezer.length).toBe(2);
    for (const u of deezer) {
      expect(u).not.toMatch(/(artist|track|album):/);
      expect(u).toContain("Kings of Leon Sex on Fire");
    }
    // Album words first, then the wider search.
    expect(deezer[0]).toContain("Only By the Night");
    expect(deezer[1]).not.toContain("Only By the Night");
  });

  it("strips quotes and colons that Deezer would parse as fields", () => {
    expect(plainQuery('artist: "X"', "Song: Part 2")).toBe("artist X Song Part 2");
    expect(plainQuery("  a ", null, undefined, "b")).toBe("a b");
  });
});

describe("MusicBrainz fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  const writes: unknown[][] = [];
  const env = {
    DB: { prepare: () => ({ bind: (...a: unknown[]) => ({ run: async () => void writes.push(a) }) }) },
  } as unknown as Env;

  const rec = (artist: string, releases: object[], score = 100) => ({
    score,
    "artist-credit": [{ name: artist }],
    releases,
  });

  it("finds the cover when Deezer misses and iTunes is rate-limited", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("deezer")) return new Response(JSON.stringify({ data: [] }));
      if (url.includes("itunes")) return new Response("", { status: 429 });
      if (url.includes("musicbrainz")) {
        return new Response(
          JSON.stringify({
            recordings: [
              rec("Kings of Leon", [
                { title: "Live at the O2", status: "Official", "release-group": { id: "live", "primary-type": "Album", "secondary-types": ["Live"] } },
                { title: "Only By the Night", status: "Official", "release-group": { id: "obtn", "primary-type": "Album" } },
              ]),
            ],
          }),
        );
      }
      // The cover check: a redirect means the cover exists.
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 307 });
    });
    const r = await lookupArtwork(env, "t1", "Sex on Fire", "Kings of Leon", null);
    expect(r.url).toBe("https://coverartarchive.org/release-group/obtn/front-500");
    expect(r.why).toEqual(["deezer: 0 results", "itunes: HTTP 429"]);
  });

  it("does not store a cover the archive does not have", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("musicbrainz")) {
        return new Response(JSON.stringify({ recordings: [rec("Kings of Leon", [{ title: "X", "release-group": { id: "g" } }])] }));
      }
      if (url.includes("coverartarchive")) return new Response(null, { status: 404 });
      return new Response(JSON.stringify({ data: [], results: [] }));
    });
    const r = await lookupArtwork(env, "t1", "Sex on Fire", "Kings of Leon", null);
    expect(r.url).toBeNull();
    expect(r.why).toContain("coverartarchive: HTTP 404");
  });

  it("ranks studio albums above live albums and compilations, and skips weak matches", () => {
    const c = mbCandidates([
      rec("A", [{ title: "Hits", "release-group": { id: "comp", "primary-type": "Album", "secondary-types": ["Compilation"] } }]),
      rec("A", [{ title: "Single", "release-group": { id: "single", "primary-type": "Single" } }]),
      rec("A", [{ title: "Record", "release-group": { id: "album", "primary-type": "Album" } }]),
      rec("B", [{ title: "Unrelated", "release-group": { id: "weak", "primary-type": "Album" } }], 40),
    ]);
    expect(c.map((x) => x.art)).toEqual(["album", "single", "comp"]);
  });
});
