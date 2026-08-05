import { describe, it, expect } from "vitest";
import { pick } from "../src/artwork";

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
