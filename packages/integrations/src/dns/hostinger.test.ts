import { afterEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "./fetch-stub.js";
import { HostingerDnsProvider } from "./hostinger.js";
import { DnsApiError } from "./http.js";

const ZONE = "grayscabline.co.uk";
const ZONE_URL = `https://developers.hostinger.com/api/dns/v1/zones/${ZONE}`;

/** What `GET /zones/{domain}` returns: record sets, one per name + type. */
const ZONE_BODY = [
  { name: "@", type: "A", ttl: 14400, records: [{ content: "84.32.84.32" }] },
  { name: "www", type: "A", ttl: 14400, records: [{ content: "84.32.84.32" }] },
  { name: "@", type: "MX", ttl: 14400, records: [{ content: "10 mx1.hostinger.com" }] },
];

const ACCEPTED = { status: 200, body: { message: "Request accepted" } };

function provider(): HostingerDnsProvider {
  return new HostingerDnsProvider({ token: "hpat-test-token", retryDelayMs: 0 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HostingerDnsProvider", () => {
  it("creates a record set that the zone does not have yet", async () => {
    const stub = stubFetch([{ status: 200, body: ZONE_BODY }, ACCEPTED]);

    const result = await provider().updateRecord({
      zone: ZONE,
      type: "CNAME",
      name: "shop",
      value: "shops.myshopify.com",
      ttl: 3600,
    });

    expect(result).toEqual({ recordId: `hostinger:${ZONE}:CNAME:shop`, applied: true, zone: ZONE });
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0]).toMatchObject({ method: "GET", url: ZONE_URL, authorization: "Bearer hpat-test-token" });
    expect(stub.calls[1]).toMatchObject({ method: "PUT", url: ZONE_URL });
    expect(stub.calls[1]!.body).toEqual({
      overwrite: false,
      zone: [{ name: "shop", type: "CNAME", ttl: 3600, records: [{ content: "shops.myshopify.com" }] }],
    });
  });

  it("updates an existing set, keeps its TTL when none is given, and accepts a fully qualified name", async () => {
    const stub = stubFetch([{ status: 200, body: ZONE_BODY }, ACCEPTED]);

    const result = await provider().updateRecord({
      zone: ZONE,
      type: "A",
      name: `www.${ZONE}`,
      value: "203.0.113.10",
    });

    expect(result.applied).toBe(true);
    expect(result.recordId).toBe(`hostinger:${ZONE}:A:www`);
    expect(stub.calls[1]!.body).toEqual({
      overwrite: false,
      zone: [{ name: "www", type: "A", ttl: 14400, records: [{ content: "203.0.113.10" }] }],
    });
  });

  it("deletes a record set by name and type, and refuses to delete one that is not there", async () => {
    const stub = stubFetch([{ status: 200, body: ZONE_BODY }, ACCEPTED]);

    const result = await provider().deleteRecord({ zone: ZONE, type: "A", name: "@" });

    expect(result).toEqual({ recordId: `hostinger:${ZONE}:A:@`, applied: true, zone: ZONE });
    expect(stub.calls[1]).toMatchObject({ method: "DELETE", url: ZONE_URL });
    expect(stub.calls[1]!.body).toEqual({ filters: [{ name: "@", type: "A" }] });

    vi.unstubAllGlobals();
    stubFetch([{ status: 200, body: ZONE_BODY }]);
    await expect(provider().deleteRecord({ zone: ZONE, type: "TXT", name: "_dmarc" })).rejects.toMatchObject({
      kind: "record_not_found",
    });
  });

  it("reports a zone that is not on the account rather than writing anything", async () => {
    const stub = stubFetch([{ status: 404, body: { message: "Not Found" } }]);

    await expect(
      provider().updateRecord({ zone: "notours.co.uk", type: "A", name: "@", value: "203.0.113.10" }),
    ).rejects.toThrow(DnsApiError);
    expect(stub.calls).toHaveLength(1);
  });

  it("reports a rejected token", async () => {
    stubFetch([{ status: 401, body: { message: "Unauthenticated." } }]);

    const error = await provider()
      .updateRecord({ zone: ZONE, type: "A", name: "@", value: "203.0.113.10" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DnsApiError);
    expect(error).toMatchObject({ kind: "auth", status: 401 });
    expect((error as DnsApiError).message).toContain("Unauthenticated.");
  });

  it("retries a 429 exactly once, then gives up", async () => {
    const stub = stubFetch([
      { status: 429, body: { message: "Too Many Attempts." } },
      { status: 200, body: ZONE_BODY },
      ACCEPTED,
    ]);

    const result = await provider().updateRecord({ zone: ZONE, type: "A", name: "@", value: "203.0.113.10" });
    expect(result.applied).toBe(true);
    expect(stub.calls).toHaveLength(3);

    vi.unstubAllGlobals();
    const second = stubFetch([
      { status: 429, body: { message: "Too Many Attempts." } },
      { status: 429, body: { message: "Too Many Attempts." } },
    ]);
    await expect(provider().updateRecord({ zone: ZONE, type: "A", name: "@", value: "203.0.113.10" })).rejects
      .toMatchObject({ kind: "rate_limited" });
    expect(second.calls).toHaveLength(2);
  });
});
