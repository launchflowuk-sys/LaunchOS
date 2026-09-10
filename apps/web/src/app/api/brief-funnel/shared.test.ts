import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  marketingHost: () => "launchflow.co.uk",
  appHost: () => "os.launchflow.co.uk",
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/public-organisation", () => ({ publicOrganisationId: async () => "org" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@launchos/core", () => ({ briefSessionBySecret: async () => null }));

const { sameOrigin } = await import("./shared");

/**
 * Behind Coolify's proxy the request URL carries the internal host while the
 * browser sends the public one. Comparing those two rejected every write in
 * production and left the form unable to accept a keystroke.
 */
function request(origin: string | null, url = "http://localhost:3000/api/brief-funnel/session") {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  return new Request(url, { method: "POST", headers });
}

describe("sameOrigin", () => {
  it("accepts the public marketing host when the request URL is internal", () => {
    expect(sameOrigin(request("https://launchflow.co.uk"))).toBe(true);
  });

  it("accepts the app host too", () => {
    expect(sameOrigin(request("https://os.launchflow.co.uk"))).toBe(true);
  });

  it("accepts localhost in development", () => {
    expect(sameOrigin(request("http://localhost:3000"))).toBe(true);
  });

  it("refuses somebody else", () => {
    expect(sameOrigin(request("https://evil.example.com"))).toBe(false);
  });

  /** A look-alike must not pass on a prefix or suffix match. */
  it("refuses a host that merely resembles ours", () => {
    expect(sameOrigin(request("https://launchflow.co.uk.evil.com"))).toBe(false);
    expect(sameOrigin(request("https://notlaunchflow.co.uk"))).toBe(false);
  });

  it("allows a request with no Origin at all, which SameSite already covers", () => {
    expect(sameOrigin(request(null))).toBe(true);
  });

  it("refuses an Origin that is not a URL", () => {
    expect(sameOrigin(request("not a url"))).toBe(false);
  });
});
