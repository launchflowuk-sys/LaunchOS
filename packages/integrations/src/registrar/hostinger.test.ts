import { describe, expect, it } from "vitest";
import { HostingerRegistrarAdapter } from "./hostinger.js";

/**
 * Shaped from the live portfolio response, not from the documentation: a real
 * account carries the free domain that came with hosting as its own entry,
 * with a null expiry, beside the paid registration of the same name.
 */
const LIVE_SHAPE = [
  { id: 1, domain: "shayanchaudary.com", type: "free_domain", status: "active", expires_at: null },
  { id: 2, domain: "shayanchaudary.com", type: "domain", status: "active", expires_at: "2027-09-11T15:50:09Z" },
  { id: 3, domain: "Cabflow.IO.", type: "domain", status: "active", expires_at: "2027-04-29T04:03:47Z" },
];

function adapter(body: unknown, status = 200) {
  return new HostingerRegistrarAdapter({
    token: "t",
    fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  });
}

describe("HostingerRegistrarAdapter", () => {
  it("keeps the entry that knows the expiry when a name appears twice", async () => {
    const rows = await adapter(LIVE_SHAPE).listDomains();
    const shayan = rows.filter((r) => r.name === "shayanchaudary.com");
    expect(shayan).toHaveLength(1);
    expect(shayan[0]!.expiresAt?.toISOString()).toBe("2027-09-11T15:50:09.000Z");
  });

  it("keeps it whichever order the two arrive in", async () => {
    const rows = await adapter([...LIVE_SHAPE].reverse()).listDomains();
    expect(rows.find((r) => r.name === "shayanchaudary.com")!.expiresAt).not.toBeNull();
  });

  it("normalises the name so it compares against ours", async () => {
    const rows = await adapter(LIVE_SHAPE).listDomains();
    expect(rows.map((r) => r.name)).toContain("cabflow.io");
  });

  it("reports auto-renew as null, because the portfolio does not carry it", async () => {
    // Not false: the sync must leave a deliberate setting alone, not overwrite it.
    const rows = await adapter(LIVE_SHAPE).listDomains();
    expect(rows.every((r) => r.autoRenew === null)).toBe(true);
  });

  it("accepts the wrapped shape too, in case the API grows an envelope", async () => {
    const rows = await adapter({ data: LIVE_SHAPE }).listDomains();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("throws rather than returning nothing when the shape is not what we expect", async () => {
    await expect(adapter({ unexpected: true }).listDomains()).rejects.toThrow(/expected shape/);
  });
});
