import { afterEach, describe, expect, it, vi } from "vitest";
import { MockCloudflareDns, MockDnsProvider, type DnsProvider } from "../cloudflare/index.js";
import { stubFetch } from "./fetch-stub.js";
import { createDnsProvidersFromEnv, DnsProviderRegistry } from "./registry.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDnsProvidersFromEnv", () => {
  it("builds mocks when no token is set", () => {
    const registry = createDnsProvidersFromEnv({});
    expect(registry.for("hostinger").name).toBe("mock-hostinger");
    expect(registry.for("cloudflare").name).toBe("mock-cloudflare");
    expect(registry.for("registrar").name).toBe("mock-dns");
  });

  it("builds each real provider independently of the other", () => {
    const hostingerOnly = createDnsProvidersFromEnv({ HOSTINGER_API_TOKEN: "hpat-live" });
    expect(hostingerOnly.for("hostinger").name).toBe("hostinger");
    expect(hostingerOnly.for("cloudflare").name).toBe("mock-cloudflare");

    const both = createDnsProvidersFromEnv({ HOSTINGER_API_TOKEN: "hpat-live", CLOUDFLARE_API_TOKEN: "cf-live" });
    expect(both.for("hostinger").name).toBe("hostinger");
    expect(both.for("cloudflare").name).toBe("cloudflare");
  });

  it("treats a blank token as unset", () => {
    const registry = createDnsProvidersFromEnv({ HOSTINGER_API_TOKEN: "   ", CLOUDFLARE_API_TOKEN: "" });
    expect(registry.for("hostinger").name).toBe("mock-hostinger");
    expect(registry.for("cloudflare").name).toBe("mock-cloudflare");
  });
});

describe("DnsProviderRegistry", () => {
  const hostinger = new MockDnsProvider("mock-hostinger");
  const cloudflare = new MockCloudflareDns();
  const fallback = new MockDnsProvider("mock-dns");
  const registry: DnsProvider = new DnsProviderRegistry({ hostinger, cloudflare }, fallback);

  it("routes each change to the provider named on the domain row", async () => {
    await registry.updateRecord({ zone: "a.co.uk", type: "A", name: "@", value: "203.0.113.1", provider: "hostinger" });
    await registry.updateRecord({ zone: "b.co.uk", type: "A", name: "@", value: "203.0.113.2", provider: "cloudflare" });

    expect(hostinger.changes.map((c) => c.zone)).toEqual(["a.co.uk"]);
    expect(cloudflare.changes.map((c) => c.zone)).toEqual(["b.co.uk"]);
  });

  it("sends anything it cannot route to the fallback rather than guessing a live zone", async () => {
    await registry.updateRecord({ zone: "c.co.uk", type: "A", name: "@", value: "203.0.113.3", provider: "registrar" });
    await registry.updateRecord({ zone: "d.co.uk", type: "A", name: "@", value: "203.0.113.4", provider: "other" });
    // No provider at all — an older caller, or a column we have not mapped yet.
    await registry.updateRecord({ zone: "e.co.uk", type: "A", name: "@", value: "203.0.113.5" });

    expect(fallback.changes.map((c) => c.zone)).toEqual(["c.co.uk", "d.co.uk", "e.co.uk"]);
    expect(registry.for?.("nonsense").name).toBe("mock-dns");
  });

  it("names the provider that will really run, so an approval card cannot claim a live zone", () => {
    const live = createDnsProvidersFromEnv({ CLOUDFLARE_API_TOKEN: "cf-live" });
    expect(live.name).toBe("dns-registry");
    expect(live.for("cloudflare").name.startsWith("mock")).toBe(false);
    expect(live.for("hostinger").name.startsWith("mock")).toBe(true);
  });

  it("routes deletions the same way", async () => {
    const live = createDnsProvidersFromEnv({ HOSTINGER_API_TOKEN: "hpat-live" });
    const stub = stubFetch([
      { status: 200, body: [{ name: "www", type: "A", ttl: 300, records: [{ content: "203.0.113.1" }] }] },
      { status: 200, body: { message: "Request accepted" } },
    ]);

    const result = await live.deleteRecord({ zone: "f.co.uk", type: "A", name: "www", provider: "hostinger" });

    expect(result.applied).toBe(true);
    expect(stub.calls[1]).toMatchObject({ method: "DELETE" });
  });
});
