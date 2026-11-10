import { describe, it, expect } from "vitest";
import {
  isAllowedArtUrl,
  isAllowedArtRedirect,
  artContentType,
  artCacheKey,
} from "../src/artProxy";

/**
 * The cover proxy must never become a general-purpose fetcher. These are the
 * URLs it will and will not touch.
 */
describe("isAllowedArtUrl", () => {
  it("allows the Deezer and Apple image hosts the lookup stores", () => {
    expect(isAllowedArtUrl("https://cdn-images.dzcdn.net/images/cover/abc/500x500-000000-80-0-0.jpg")).toBe(true);
    expect(isAllowedArtUrl("https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg")).toBe(true);
    expect(isAllowedArtUrl("https://is1-ssl.mzstatic.com/image/thumb/Music/x/600x600bb.jpg")).toBe(true);
  });

  it("refuses any other host", () => {
    expect(isAllowedArtUrl("https://example.com/cover.jpg")).toBe(false);
    expect(isAllowedArtUrl("https://hc.auxgoat.com/api/admin/pi/commands")).toBe(false);
  });

  it("refuses a lookalike host that only contains the name", () => {
    expect(isAllowedArtUrl("https://dzcdn.net.evil.com/x.jpg")).toBe(false);
    expect(isAllowedArtUrl("https://evilmzstatic.com/x.jpg")).toBe(false);
  });

  it("refuses plain http, other ports and embedded credentials", () => {
    expect(isAllowedArtUrl("http://cdn-images.dzcdn.net/x.jpg")).toBe(false);
    expect(isAllowedArtUrl("https://cdn-images.dzcdn.net:8443/x.jpg")).toBe(false);
    expect(isAllowedArtUrl("https://user:pw@cdn-images.dzcdn.net/x.jpg")).toBe(false);
  });

  it("refuses junk", () => {
    expect(isAllowedArtUrl(undefined)).toBe(false);
    expect(isAllowedArtUrl("")).toBe(false);
    expect(isAllowedArtUrl("not a url")).toBe(false);
  });
});

describe("redirect hops (2e)", () => {
  it("follow Cover Art Archive onto archive.org mirrors, and nowhere else", () => {
    expect(isAllowedArtRedirect("https://coverartarchive.org/release/abc/123-500.jpg")).toBe(true);
    expect(isAllowedArtRedirect("https://archive.org/download/mbid-abc/mbid-abc-123_thumb500.jpg")).toBe(true);
    expect(isAllowedArtRedirect("https://ia800505.us.archive.org/9/items/mbid-abc/x.jpg")).toBe(true);
    expect(isAllowedArtRedirect("https://evil.example/x.jpg")).toBe(false);
    expect(isAllowedArtRedirect("http://archive.org/x.jpg")).toBe(false);
    expect(isAllowedArtRedirect("https://169.254.169.254/latest")).toBe(false);
  });

  it("but archive.org is not a cover URL in its own right", () => {
    expect(isAllowedArtUrl("https://archive.org/download/x.jpg")).toBe(false);
  });
});

describe("served types (2e)", () => {
  it("are raster images only", () => {
    expect(artContentType("image/jpeg")).toBe("image/jpeg");
    expect(artContentType("IMAGE/PNG; charset=binary")).toBe("image/png");
    expect(artContentType("image/webp")).toBe("image/webp");
    expect(artContentType("image/gif")).toBe("image/gif");
    expect(artContentType("image/svg+xml")).toBeNull();
    expect(artContentType("text/html")).toBeNull();
    expect(artContentType(null)).toBeNull();
  });
});

describe("cache key (2e)", () => {
  it("is built from u alone", () => {
    const u = "https://is1-ssl.mzstatic.com/image/thumb/a b&c/600x600bb.jpg";
    const a = artCacheKey("https://hc.example/api/art?u=" + encodeURIComponent(u) + "&x=1", u);
    const b = artCacheKey("https://hc.example/api/art?x=2&u=" + encodeURIComponent(u), u);
    expect(a).toBe(b);
    expect(new URL(a).searchParams.get("u")).toBe(u);
    expect([...new URL(a).searchParams.keys()]).toEqual(["u"]);
  });
});
