import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { describe, expect, it } from "vitest";
import { clientUsagePence, costPenceFor, rateInForce, recordUsage, setUsageRate, unpricedUsage, usageTotals } from "./usage.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "LF", slug: `lf-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function makeClient(db: Db, organisationId: string) {
  const [client] = await db
    .insert(schema.clients)
    .values({ organisationId, name: "A client", slug: `c-${crypto.randomUUID()}` })
    .returning();
  return client!;
}

/**
 * Opus 5 output is about £59 per million tokens, so 5,900 micro-pence a token
 * (0.0059p each). Haiku input is about £0.63 per million — 63 micro-pence.
 * Real orders of magnitude, because a test with a made-up rate proves the
 * arithmetic and not the units.
 */
const OPUS_OUT = 5_900;
const HAIKU_IN = 63;
/** gpt-image-1 at 1024x1024 is about 3p an image. */
const IMAGE_1024 = 3_000_000;

describe("costPenceFor", () => {
  it("prices a realistic token count", () => {
    // 120,000 Opus output tokens at 5,900 micro-pence = 708p, about £7.
    expect(costPenceFor(120_000, OPUS_OUT)).toBe(708);
  });

  it("keeps fractions of a penny instead of rounding every small call to nothing", () => {
    // 1,000 Haiku input tokens is 0.063p, which rounds to nothing — correct
    // for one call. The point of micro-pence is that ten million such tokens
    // come to 630p rather than nought.
    expect(costPenceFor(1_000, HAIKU_IN)).toBe(0);
    expect(costPenceFor(10_000_000, HAIKU_IN)).toBe(630);
  });

  it("is zero for nonsense rather than NaN", () => {
    expect(costPenceFor(0, 6)).toBe(0);
    expect(costPenceFor(100, 0)).toBe(0);
    expect(costPenceFor(-5, OPUS_OUT)).toBe(0);
    expect(costPenceFor(Number.NaN, OPUS_OUT)).toBe(0);
  });
});

describe("rateInForce", () => {
  it("takes the newest rate on or before the day, never a later one", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await setUsageRate(db, org.id, {
        supplier: "anthropic", product: "tokens_out", variant: "claude-opus-5",
        microPencePerUnit: 5_900, effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      });
      await setUsageRate(db, org.id, {
        supplier: "anthropic", product: "tokens_out", variant: "claude-opus-5",
        microPencePerUnit: 7_500, effectiveFrom: new Date(Date.UTC(2026, 8, 1)),
      });

      const august = await rateInForce(db, org.id, {
        supplier: "anthropic", product: "tokens_out", variant: "claude-opus-5", at: new Date(Date.UTC(2026, 7, 15)),
      });
      const september = await rateInForce(db, org.id, {
        supplier: "anthropic", product: "tokens_out", variant: "claude-opus-5", at: new Date(Date.UTC(2026, 8, 15)),
      });

      // A price rise in September must not rewrite what August cost.
      expect(august!.microPencePerUnit).toBe(5_900);
      expect(september!.microPencePerUnit).toBe(7_500);
    });
  });

  it("prefers a variant rate over the supplier catch-all", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await setUsageRate(db, org.id, { supplier: "openai", product: "tokens_out", variant: null, microPencePerUnit: 2 });
      await setUsageRate(db, org.id, { supplier: "openai", product: "tokens_out", variant: "gpt-6-astra", microPencePerUnit: 8 });

      const specific = await rateInForce(db, org.id, { supplier: "openai", product: "tokens_out", variant: "gpt-6-astra" });
      const fallback = await rateInForce(db, org.id, { supplier: "openai", product: "tokens_out", variant: "some-other-model" });

      expect(specific!.microPencePerUnit).toBe(8);
      expect(fallback!.microPencePerUnit).toBe(2);
    });
  });

  it("is null when nothing is priced", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      expect(await rateInForce(db, org.id, { supplier: "twilio", product: "message" })).toBeNull();
    });
  });
});

describe("recordUsage", () => {
  it("prices at write time and stores the rate it used", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const rate = await setUsageRate(db, org.id, {
        supplier: "anthropic", product: "tokens_out", variant: "claude-opus-5", microPencePerUnit: OPUS_OUT,
      });

      const row = await recordUsage(db, org.id, {
        supplier: "anthropic", product: "tokens_out", variant: "claude-opus-5",
        quantity: 120_000, source: "agent_run", idempotencyKey: "agent_run:abc:tokens_out",
      });

      expect(row!.costPence).toBe(708);
      expect(row!.rateId).toBe(rate.id);
    });
  });

  it("writes once, so a retried job does not double the month", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await setUsageRate(db, org.id, { supplier: "anthropic", product: "tokens_out", microPencePerUnit: OPUS_OUT });

      const first = await recordUsage(db, org.id, {
        supplier: "anthropic", product: "tokens_out", quantity: 100_000, idempotencyKey: "run:1:out",
      });
      const retry = await recordUsage(db, org.id, {
        supplier: "anthropic", product: "tokens_out", quantity: 100_000, idempotencyKey: "run:1:out",
      });

      expect(first).not.toBeNull();
      // Null, not a second row: the first write is the truth.
      expect(retry).toBeNull();
      const totals = await usageTotals(db, org.id);
      expect(totals.totalPence).toBe(590);
    });
  });

  it("records an unpriced call at zero rather than dropping it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const row = await recordUsage(db, org.id, {
        supplier: "screenshotone", product: "screenshot", quantity: 40, unit: "capture", idempotencyKey: "shots:sep",
      });

      expect(row!.costPence).toBe(0);
      expect(row!.rateId).toBeNull();
      // Visible and free beats invisible: this is what the screen tells a
      // person to go and price.
      const unpriced = await unpricedUsage(db, org.id);
      expect(unpriced).toHaveLength(1);
      expect(unpriced[0]!.supplier).toBe("screenshotone");
      expect(Number(unpriced[0]!.quantity)).toBe(40);
    });
  });

  it("ignores a zero-quantity call", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      expect(await recordUsage(db, org.id, { supplier: "openai", product: "tokens_in", quantity: 0, idempotencyKey: "z" })).toBeNull();
    });
  });
});

describe("usageTotals", () => {
  it("splits by business, supplier and source, and counts what is unpriced", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await setUsageRate(db, org.id, { supplier: "anthropic", product: "tokens_out", microPencePerUnit: OPUS_OUT });
      await setUsageRate(db, org.id, { supplier: "openai", product: "image", variant: "1024x1024", microPencePerUnit: IMAGE_1024 });

      await recordUsage(db, org.id, {
        supplier: "anthropic", product: "tokens_out", quantity: 100_000,
        business: "launchflow", source: "agent_run", idempotencyKey: "a",
      });
      await recordUsage(db, org.id, {
        supplier: "openai", product: "image", variant: "1024x1024", quantity: 4, unit: "image",
        business: "launchflow", source: "image_render", idempotencyKey: "b",
      });
      await recordUsage(db, org.id, {
        supplier: "postmark", product: "email", quantity: 500, unit: "email", source: "email_send", idempotencyKey: "c",
      });

      const totals = await usageTotals(db, org.id);

      // 590p of Opus output + 4 images at 3p = 12p => 602p. Postmark is unpriced.
      expect(totals.totalPence).toBe(602);
      expect(totals.byBusiness).toEqual([{ business: "launchflow", pence: 602 }]);
      expect(totals.bySupplier.map((s) => s.supplier)).toEqual(["anthropic", "openai"]);
      expect(totals.unpricedEvents).toBe(1);
    });
  });

  it("counts only this month", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await setUsageRate(db, org.id, {
        supplier: "anthropic", product: "tokens_out", microPencePerUnit: 5_900, effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      });
      await recordUsage(db, org.id, {
        supplier: "anthropic", product: "tokens_out", quantity: 100_000,
        occurredAt: new Date(Date.UTC(2026, 7, 10)), idempotencyKey: "aug",
      });
      await recordUsage(db, org.id, {
        supplier: "anthropic", product: "tokens_out", quantity: 200_000,
        occurredAt: new Date(Date.UTC(2026, 8, 10)), idempotencyKey: "sep",
      });

      const september = await usageTotals(db, org.id, new Date(Date.UTC(2026, 8, 20)));
      expect(september.totalPence).toBe(1_180);
    });
  });
});

describe("clientUsagePence", () => {
  it("gives one client's variable cost, ignoring company-wide work", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await makeClient(db, org.id);
      await setUsageRate(db, org.id, { supplier: "openai", product: "tokens_out", microPencePerUnit: OPUS_OUT });

      await recordUsage(db, org.id, {
        supplier: "openai", product: "tokens_out", quantity: 100_000, clientId: client.id,
        source: "site_build", idempotencyKey: "theirs",
      });
      // A nightly ops brief belongs to nobody and must not land on a client.
      await recordUsage(db, org.id, {
        supplier: "openai", product: "tokens_out", quantity: 500_000, clientId: null,
        source: "agent_run", idempotencyKey: "ours",
      });

      expect(await clientUsagePence(db, org.id, client.id)).toBe(590);
      expect((await usageTotals(db, org.id)).totalPence).toBe(3_540);
    });
  });
});
