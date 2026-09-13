import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { CostBusiness } from "./register.js";

/**
 * Recording what a paid call cost, at the moment it was made.
 *
 * Two rules hold this together, and both exist so a past month's figure never
 * moves:
 *
 * 1. **Priced at write time** from the rate in force on the day. Pricing at
 *    read time means a provider's price rise silently rewrites last quarter.
 * 2. **Written once.** `idempotencyKey` is unique per organisation, so a
 *    pg-boss job that retries after committing does not double the month. For
 *    a queue that is normal behaviour, not an edge case.
 *
 * A call with no matching rate is still recorded, at `costPence: 0` with a null
 * `rateId`. Visible and free beats invisible: `unpricedUsage` lists exactly
 * what needs a rate, and the Profit screen says so.
 */

export type UsageProduct = (typeof schema.usageProductEnum.enumValues)[number];
export type UsageSource = (typeof schema.usageSourceEnum.enumValues)[number];
export const USAGE_PRODUCTS = schema.usageProductEnum.enumValues;

/** Micro-pence per unit to pence, rounded once at the end. */
export function costPenceFor(quantity: number, microPencePerUnit: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  if (!Number.isFinite(microPencePerUnit) || microPencePerUnit <= 0) return 0;
  return Math.round((quantity * microPencePerUnit) / 1_000_000);
}

export const RecordUsageInput = z.object({
  supplier: z.enum(schema.supplierEnum.enumValues),
  product: z.enum(schema.usageProductEnum.enumValues),
  /** The model, image size or channel the rate card keys on. */
  variant: z.string().trim().max(120).nullable().default(null),
  quantity: z.number().int().min(0),
  unit: z.string().trim().max(20).default("token"),
  clientId: z.string().uuid().nullable().default(null),
  business: z.enum(schema.costBusinessEnum.enumValues).default("launchflow"),
  source: z.enum(schema.usageSourceEnum.enumValues).default("other"),
  sourceId: z.string().uuid().nullable().default(null),
  occurredAt: z.date().default(() => new Date()),
  /**
   * What makes this write once. Build it from the thing that produced the
   * usage, such as `agent_run:<id>:tokens_out` — never from a timestamp, or a
   * retry gets a fresh key and counts twice.
   */
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type RecordUsageInput = z.input<typeof RecordUsageInput>;

/**
 * The rate in force for a supplier, product and variant on a given day.
 *
 * A variant-specific rate wins over the supplier's catch-all, and the latest
 * one on or before the day wins over an older one. Null when nothing matches.
 */
export async function rateInForce(
  db: Db,
  organisationId: string,
  input: { supplier: string; product: UsageProduct; variant?: string | null; at?: Date },
): Promise<{ id: string; microPencePerUnit: number } | null> {
  const at = input.at ?? new Date();
  const variant = input.variant?.trim() || null;

  const [row] = await db
    .select({ id: schema.usageRates.id, microPencePerUnit: schema.usageRates.microPencePerUnit })
    .from(schema.usageRates)
    .where(
      and(
        eq(schema.usageRates.organisationId, organisationId),
        eq(schema.usageRates.supplier, input.supplier as never),
        eq(schema.usageRates.product, input.product),
        lt(schema.usageRates.effectiveFrom, new Date(at.getTime() + 1)),
        variant
          ? or(eq(schema.usageRates.variant, variant), isNull(schema.usageRates.variant))
          : isNull(schema.usageRates.variant),
      ),
    )
    .orderBy(
      sql`case when ${schema.usageRates.variant} is null then 1 else 0 end`,
      desc(schema.usageRates.effectiveFrom),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Records one paid call.
 *
 * Returns null when the quantity is zero, and null when this key has already
 * been written — a caller must be able to retry without checking first.
 */
export async function recordUsage(db: Db, organisationId: string, input: RecordUsageInput) {
  const v = RecordUsageInput.parse(input);
  if (v.quantity === 0) return null;

  const rate = await rateInForce(db, organisationId, {
    supplier: v.supplier,
    product: v.product,
    variant: v.variant,
    at: v.occurredAt,
  });

  const [row] = await db
    .insert(schema.usageEvents)
    .values({
      organisationId,
      clientId: v.clientId,
      business: v.business,
      supplier: v.supplier,
      product: v.product,
      variant: v.variant,
      quantity: v.quantity,
      unit: v.unit,
      costPence: rate ? costPenceFor(v.quantity, rate.microPencePerUnit) : 0,
      rateId: rate?.id ?? null,
      source: v.source,
      sourceId: v.sourceId,
      occurredAt: v.occurredAt,
      idempotencyKey: v.idempotencyKey,
    })
    // The point of the unique key: a retry is a no-op, not a double charge.
    // `doNothing` rather than an upsert — the first write is the truth.
    .onConflictDoNothing({ target: [schema.usageEvents.organisationId, schema.usageEvents.idempotencyKey] })
    .returning();

  return row ?? null;
}

export const SetUsageRateInput = z.object({
  supplier: z.enum(schema.supplierEnum.enumValues),
  product: z.enum(schema.usageProductEnum.enumValues),
  variant: z.string().trim().max(120).nullable().default(null),
  microPencePerUnit: z.number().int().min(0),
  effectiveFrom: z.date().default(() => new Date()),
  note: z.string().trim().max(300).nullable().default(null),
});
export type SetUsageRateInput = z.input<typeof SetUsageRateInput>;

/** Adds a rate. Never edits an old one — that history is what keeps a closed month stable. */
export async function setUsageRate(db: Db, organisationId: string, input: SetUsageRateInput) {
  const v = SetUsageRateInput.parse(input);
  const [row] = await db
    .insert(schema.usageRates)
    .values({
      organisationId,
      supplier: v.supplier,
      product: v.product,
      variant: v.variant,
      microPencePerUnit: v.microPencePerUnit,
      effectiveFrom: v.effectiveFrom,
      note: v.note,
    })
    .returning();
  return row!;
}

export interface UsageTotals {
  /** GBP pence. */
  totalPence: number;
  byBusiness: { business: CostBusiness; pence: number }[];
  bySupplier: { supplier: string; pence: number }[];
  bySource: { source: UsageSource; pence: number }[];
  /** Events with no rate. Cost is understated by whatever these come to. */
  unpricedEvents: number;
}

/** Usage cost for a calendar month, in GBP pence. */
export async function usageTotals(db: Db, organisationId: string, now: Date = new Date()): Promise<UsageTotals> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const where = and(
    eq(schema.usageEvents.organisationId, organisationId),
    gte(schema.usageEvents.occurredAt, from),
    lt(schema.usageEvents.occurredAt, to),
  );

  const [rows, unpriced] = await Promise.all([
    db
      .select({
        business: schema.usageEvents.business,
        supplier: schema.usageEvents.supplier,
        source: schema.usageEvents.source,
        pence: sql<string>`coalesce(sum(${schema.usageEvents.costPence}), 0)`,
      })
      .from(schema.usageEvents)
      .where(where)
      .groupBy(schema.usageEvents.business, schema.usageEvents.supplier, schema.usageEvents.source),
    db
      .select({ n: sql<string>`count(*)` })
      .from(schema.usageEvents)
      .where(and(where, isNull(schema.usageEvents.rateId))),
  ]);

  function group<K extends string>(key: (row: (typeof rows)[number]) => K): [K, number][] {
    const map = new Map<K, number>();
    for (const row of rows) map.set(key(row), (map.get(key(row)) ?? 0) + Number(row.pence));
    return [...map.entries()].filter(([, pence]) => pence > 0).sort((a, b) => b[1] - a[1]);
  }

  return {
    totalPence: rows.reduce((total, row) => total + Number(row.pence), 0),
    byBusiness: group((row) => row.business).map(([business, pence]) => ({ business, pence })),
    bySupplier: group((row) => row.supplier).map(([supplier, pence]) => ({ supplier, pence })),
    bySource: group((row) => row.source).map(([source, pence]) => ({ source, pence })),
    unpricedEvents: Number(unpriced[0]?.n ?? 0),
  };
}

/** What one client's variable usage cost this month — the client Profit tab's figure. */
export async function clientUsagePence(
  db: Db,
  organisationId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<number> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [row] = await db
    .select({ pence: sql<string>`coalesce(sum(${schema.usageEvents.costPence}), 0)` })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.organisationId, organisationId),
        eq(schema.usageEvents.clientId, clientId),
        gte(schema.usageEvents.occurredAt, from),
        lt(schema.usageEvents.occurredAt, to),
      ),
    );
  return Number(row?.pence ?? 0);
}

/** Combinations seen this month with no rate, so a person can price exactly those. */
export async function unpricedUsage(db: Db, organisationId: string, now: Date = new Date()) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return db
    .select({
      supplier: schema.usageEvents.supplier,
      product: schema.usageEvents.product,
      variant: schema.usageEvents.variant,
      events: sql<string>`count(*)`,
      quantity: sql<string>`coalesce(sum(${schema.usageEvents.quantity}), 0)`,
    })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.organisationId, organisationId),
        isNull(schema.usageEvents.rateId),
        gte(schema.usageEvents.occurredAt, from),
      ),
    )
    .groupBy(schema.usageEvents.supplier, schema.usageEvents.product, schema.usageEvents.variant);
}

/** What a model call reported, as the integrations leaf hands it back. */
export interface MeteredLlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  model: string;
}

/**
 * Records one model call's tokens — input, output and cache reads.
 *
 * A helper because every call site would otherwise repeat three near-identical
 * `recordUsage` calls and invent its own key shape, and an inconsistent key is
 * a double charge waiting for a retry.
 *
 * `keyPrefix` must identify the thing that produced the usage and nothing
 * else: `brief:<submissionId>:v3`, never a timestamp. Never throws — a cost we
 * failed to write is worth less than the work that was actually done.
 */
export async function meterLlmUsage(
  db: Db,
  organisationId: string,
  usage: MeteredLlmUsage | undefined,
  context: {
    supplier: "anthropic" | "openai";
    source: UsageSource;
    sourceId?: string | null;
    clientId?: string | null;
    business?: (typeof schema.costBusinessEnum.enumValues)[number];
    keyPrefix: string;
  },
): Promise<void> {
  if (!usage) return;
  const common = {
    supplier: context.supplier,
    variant: usage.model,
    unit: "token",
    clientId: context.clientId ?? null,
    business: context.business ?? ("launchflow" as const),
    source: context.source,
    sourceId: context.sourceId ?? null,
  };
  try {
    await Promise.all([
      recordUsage(db, organisationId, {
        ...common, product: "tokens_in", quantity: usage.inputTokens,
        idempotencyKey: `${context.keyPrefix}:tokens_in`,
      }),
      recordUsage(db, organisationId, {
        ...common, product: "tokens_out", quantity: usage.outputTokens,
        idempotencyKey: `${context.keyPrefix}:tokens_out`,
      }),
      recordUsage(db, organisationId, {
        ...common, product: "tokens_in_cached", quantity: usage.cachedInputTokens ?? 0,
        idempotencyKey: `${context.keyPrefix}:tokens_cached`,
      }),
    ]);
  } catch {
    // Deliberately swallowed. See the note above: the brief, the site or the
    // image is the valuable output, and a ledger write must never be what
    // fails it.
  }
}
