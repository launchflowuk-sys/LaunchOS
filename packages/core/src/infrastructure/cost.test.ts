import { describe, expect, it } from "vitest";
import { MOCK_SERVERS } from "@launchos/integrations";
import { serverCost } from "./cost.js";

const pricing = { backupPercent: 20, volumeMilliCentsPerGbMonth: 5720, imageMilliCentsPerGbMonth: 1430, primaryIpv4MonthlyCents: { fsn1: 50, nbg1: 50 } };
const cabio = MOCK_SERVERS[0]!; // cpx32 fsn1, €35.49, backups on, created May
const pizza = MOCK_SERVERS[1]!; // cx23 nbg1, €5.49, backups off, created 5 Sep

const at = (iso: string) => new Date(iso);

describe("serverCost", () => {
  it("caps the base at the monthly price once enough hours have run", () => {
    const c = serverCost({ server: cabio, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-30T23:00:00Z") });
    expect(c.base).toBe(3549);
  });

  it("prorates by the hour early in the month", () => {
    // 10 hours × 0.0569 €/h = 0.569 € → 57 cents
    const c = serverCost({ server: cabio, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-01T10:00:00Z") });
    expect(c.base).toBe(57);
  });

  it("counts from creation, not month start, for a server made this month", () => {
    // pizza created 5 Sep 00:00; at 6 Sep 00:00 → 24 h × 0.0088 = 0.2112 € → 21 cents
    const c = serverCost({ server: pizza, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-06T00:00:00Z") });
    expect(c.base).toBe(21);
  });

  it("adds backups at the percentage, volumes, primary IPv4 and snapshots on the projected month", () => {
    const c = serverCost({
      server: cabio,
      volumes: [{ id: 1, serverId: cabio.id, sizeGb: 100 }, { id: 2, serverId: 999, sizeGb: 50 }],
      primaryIps: [{ id: 1, type: "ipv4", assigneeId: cabio.id }, { id: 2, type: "ipv6", assigneeId: cabio.id }],
      snapshots: [{ id: 1, sizeGb: 10, createdFrom: cabio.id, description: "" }],
      pricing,
      now: at("2026-09-30T23:00:00Z"),
    });
    expect(c.backups).toBe(710);   // 20% of 3549, rounded
    expect(c.volumes).toBe(572);   // 100 GB × 0.0572
    expect(c.primaryIps).toBe(50); // ipv4 only
    expect(c.snapshots).toBe(14);  // 10 GB × 0.0143
    expect(c.projectedMonth).toBe(3549 + 710 + 572 + 50 + 14);
  });

  it("charges traffic only above the allowance", () => {
    const heavy = { ...pizza, outgoingTrafficBytes: pizza.includedTrafficBytes + 2 * 1024 ** 4 };
    expect(serverCost({ server: heavy, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-30T23:00:00Z") }).traffic).toBe(200);
    expect(serverCost({ server: pizza, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-30T23:00:00Z") }).traffic).toBe(0);
  });
});
