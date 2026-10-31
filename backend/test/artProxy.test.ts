import { describe, it, expect } from "vitest";
import { isAllowedArtUrl, proxiedArtPath } from "../src/artProxy";

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
    expect(isAllowedArtUrl("https://lockerroom.finestkindfarms.com/api/admin/pi/commands")).toBe(false);
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

describe("proxiedArtPath", () => {
  it("round-trips through the query string", () => {
    const raw = "https://is1-ssl.mzstatic.com/image/thumb/a b&c/600x600bb.jpg";
    const path = proxiedArtPath(raw);
    expect(new URL(path, "https://x.test").searchParams.get("u")).toBe(raw);
  });
});
