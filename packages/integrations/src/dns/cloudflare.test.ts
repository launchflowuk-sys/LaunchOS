import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareDnsProvider } from "./cloudflare.js";
import { stubFetch } from "./fetch-stub.js";
import { DnsApiError } from "./http.js";

const ZONE = "grayscabline.co.uk";
const ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353";
const RECORD_ID = "372e67954025e0ba6aaa6d586b9e0b59";
const BASE = "https://api.cloudflare.com/client/v4";

function envelope<T>(result: T) {
  return { status: 200, body: { success: true, errors: [], messages: [], result } };
}

const ZONE_LOOKUP = envelope([{ id: ZONE_ID, name: ZONE, status: "active" }]);
const NO_RECORDS = envelope([]);
const EXISTING_RECORD = envelope([
  { id: RECORD_ID, type: "A", name: `www.${ZONE}`, content: "203.0.113.1", ttl: 300, proxied: false },
]);

function provider(): CloudflareDnsProvider {
  return new CloudflareDnsProvider({ token: "cf-test-token", retryDelayMs: 0 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudflareDnsProvider", () => {
  it("creates a record when the zone has none of that name and type", async () => {
    const stub = stubFetch([
      ZONE_LOOKUP,
      NO_RECORDS,
      envelope({ id: "new-record-id", type: "TXT", name: `_dmarc.${ZONE}`, content: "v=DMARC1; p=none" }),
    ]);

    const result = await provider().updateRecord({
      zone: ZONE,
      type: "TXT",
      name: "_dmarc",
      value: "v=DMARC1; p=none",
      ttl: 3600,
      // Ignored: Cloudflare rejects `proxied` on a TXT record.
      proxied: true,
    });

    expect(result).toEqual({ recordId: "new-record-id", applied: true, zone: ZONE });
    expect(stub.calls[0]).toMatchObject({
      method: "GET",
      url: `${BASE}/zones?name=grayscabline.co.uk`,
      authorization: "Bearer cf-test-token",
    });
    expect(stub.calls[1]!.url).toBe(`${BASE}/zones/${ZONE_ID}/dns_records?type=TXT&name=_dmarc.${ZONE}`);
    expect(stub.calls[2]).toMatchObject({ method: "POST", url: `${BASE}/zones/${ZONE_ID}/dns_records` });
    expect(stub.calls[2]!.body).toEqual({
      type: "TXT",
      name: `_dmarc.${ZONE}`,
      content: "v=DMARC1; p=none",
      ttl: 3600,
    });
  });

  it("updates the existing record by id, sends proxied for an A record, and caches the zone id", async () => {
    const stub = stubFetch([
      ZONE_LOOKUP,
      EXISTING_RECORD,
      envelope({ id: RECORD_ID, type: "A", name: `www.${ZONE}`, content: "203.0.113.10" }),
      EXISTING_RECORD,
      envelope({ id: RECORD_ID, type: "A", name: `www.${ZONE}`, content: "203.0.113.11" }),
    ]);
    const cloudflare = provider();

    const first = await cloudflare.updateRecord({
      zone: ZONE,
      type: "A",
      name: "www",
      value: "203.0.113.10",
      proxied: true,
    });

    expect(first).toEqual({ recordId: RECORD_ID, applied: true, zone: ZONE });
    expect(stub.calls[2]).toMatchObject({ method: "PUT", url: `${BASE}/zones/${ZONE_ID}/dns_records/${RECORD_ID}` });
    expect(stub.calls[2]!.body).toEqual({
      type: "A",
      name: `www.${ZONE}`,
      content: "203.0.113.10",
      ttl: 300,
      proxied: true,
    });

    await cloudflare.updateRecord({ zone: ZONE, type: "A", name: "www", value: "203.0.113.11" });
    // Five requests, not six: the second change reuses the cached zone id.
    expect(stub.calls).toHaveLength(5);
    expect(stub.calls[3]!.url).toContain("/dns_records?type=A");
  });

  it("deletes a record it can find and refuses one it cannot", async () => {
    const stub = stubFetch([ZONE_LOOKUP, EXISTING_RECORD, envelope({ id: RECORD_ID })]);

    const result = await provider().deleteRecord({ zone: ZONE, type: "A", name: "www" });
    expect(result).toEqual({ recordId: RECORD_ID, applied: true, zone: ZONE });
    expect(stub.calls[2]).toMatchObject({
      method: "DELETE",
      url: `${BASE}/zones/${ZONE_ID}/dns_records/${RECORD_ID}`,
    });

    vi.unstubAllGlobals();
    stubFetch([ZONE_LOOKUP, NO_RECORDS]);
    await expect(provider().deleteRecord({ zone: ZONE, type: "A", name: "gone" })).rejects.toMatchObject({
      kind: "record_not_found",
    });
  });

  it("treats an empty zone lookup as zone-not-found and never asks for records", async () => {
    const stub = stubFetch([envelope([])]);

    await expect(
      provider().updateRecord({ zone: "notours.co.uk", type: "A", name: "@", value: "203.0.113.10" }),
    ).rejects.toMatchObject({ kind: "zone_not_found" });
    expect(stub.calls).toHaveLength(1);
  });

  it("reports a rejected token", async () => {
    stubFetch([{ status: 403, body: { success: false, errors: [{ code: 9109, message: "Invalid access token" }] } }]);

    const error = await provider()
      .updateRecord({ zone: ZONE, type: "A", name: "@", value: "203.0.113.10" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DnsApiError);
    expect(error).toMatchObject({ kind: "auth", status: 403 });
    expect((error as DnsApiError).message).toContain("Invalid access token");
  });

  it("retries a 429 exactly once, then gives up", async () => {
    const rateLimited = { status: 429, body: { success: false, errors: [{ code: 10000, message: "Rate limited" }] } };
    const stub = stubFetch([
      rateLimited,
      ZONE_LOOKUP,
      NO_RECORDS,
      envelope({ id: "new-record-id", type: "A", name: ZONE, content: "203.0.113.10" }),
    ]);

    const result = await provider().updateRecord({ zone: ZONE, type: "A", name: "@", value: "203.0.113.10" });
    expect(result.applied).toBe(true);
    expect(stub.calls).toHaveLength(4);

    vi.unstubAllGlobals();
    const second = stubFetch([rateLimited, rateLimited]);
    await expect(provider().updateRecord({ zone: ZONE, type: "A", name: "@", value: "203.0.113.10" })).rejects
      .toMatchObject({ kind: "rate_limited" });
    expect(second.calls).toHaveLength(2);
  });

  it("never reports applied when the envelope says the write failed", async () => {
    stubFetch([
      ZONE_LOOKUP,
      NO_RECORDS,
      { status: 200, body: { success: false, errors: [{ code: 1004, message: "DNS validation error" }], result: null } },
    ]);

    await expect(provider().updateRecord({ zone: ZONE, type: "A", name: "@", value: "not-an-ip" })).rejects
      .toMatchObject({ kind: "http" });
  });
});
