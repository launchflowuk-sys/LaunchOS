import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { monthlyMinor, yearlyMinor, type VatTreatment } from "./normalise.js";

/**
 * The cost register: one row per thing LaunchFlow pays for.
 *
 * `supplier_costs` began as a read-only mirror of one registrar's API, which
 * is why it is keyed on an external id. It is now also the register a person
 * types into — Hetzner, the AI providers, GitHub, Apple — so a row has a
 * `source` (`sync` or `manual`), a `business`, and a VAT treatment. Generalised
 * rather than duplicated: one table means the Profit screen reads one place,
 * and a cost cannot be counted twice by being in both.
 *
 * Manual rows have no `externalId`, so the sync's uniqueness guarantee is
 * untouched — Postgres permits many nulls in a unique index.
 */

export const COST_BUSINESSES = schema.costBusinessEnum.enumValues;
export type CostBusiness = (typeof COST_BUSINESSES)[number];
export const COST_SUPPLIERS = schema.supplierEnum.enumValues;
export type CostSupplier = (typeof COST_SUPPLIERS)[number];
export const VAT_TREATMENTS = schema.vatTreatmentEnum.enumValues;

/** How a business reads on screen. The enum values are database identifiers, not labels. */
export const BUSINESS_LABELS: Record<CostBusiness, string> = {
  launchflow: "LaunchFlow",
  cabio: "Cabio",
  grays_cabline: "Grays CabLine",
  mobile_pc_doctor: "Mobile PC Doctor",
  agent_zero: "Agent Zero",
  nexus_education: "Nexus Education",
  strix: "Strix Compliance",
  grays_park_masjid: "Grays Park Masjid",
  shared: "Shared",
};

export const VAT_TREATMENT_LABELS: Record<VatTreatment, string> = {
  standard: "UK VAT (reclaimable)",
  reverse_charge: "Reverse charge",
  exempt: "Exempt",
  none: "No VAT",
};

const Money = z.number().int().min(0).max(100_000_000);

export const UpsertCostInput = z.object({
  /** Omitted to create; supplied to edit. */
  id: z.string().uuid().optional(),
  supplier: z.enum(COST_SUPPLIERS),
  name: z.string().trim().min(1).max(200),
  business: z.enum(COST_BUSINESSES).default("launchflow"),
  /** Net, in the supplier's own currency's minor units. */
  renewalPrice: Money.default(0),
  currencyCode: z.string().trim().toUpperCase().length(3).default("GBP"),
  billingPeriod: z.number().int().min(1).max(60).default(1),
  billingPeriodUnit: z.enum(["day", "week", "month", "year"]).default("month"),
  vatTreatment: z.enum(VAT_TREATMENTS).default("none"),
  /** The supplier's own word. `active`, `in_trial`, `cancelled`. */
  status: z.string().trim().min(1).max(40).default("active"),
  nextBillingAt: z.date().nullable().default(null),
  clientId: z.string().uuid().nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
  actorId: z.string().min(1),
});
export type UpsertCostInput = z.input<typeof UpsertCostInput>;

export type RegisterRow = typeof schema.supplierCosts.$inferSelect;

/**
 * Creates or edits a manual register row.
 *
 * Refuses to edit a synced row's money: those figures are the supplier's and
 * are overwritten on the next sync, so accepting an edit would show a change
 * that silently reverts. The `business`, VAT treatment and notes on a synced
 * row *are* editable — the sync has no opinion on those and never will.
 */
export async function upsertCost(db: Db, organisationId: string, input: UpsertCostInput): Promise<RegisterRow> {
  const v = UpsertCostInput.parse(input);

  if (v.id) {
    const [before] = await db
      .select()
      .from(schema.supplierCosts)
      .where(and(eq(schema.supplierCosts.id, v.id), eq(schema.supplierCosts.organisationId, organisationId)));
    if (!before) throw new Error("that cost could not be found");

    const editable =
      before.source === "manual"
        ? {
            supplier: v.supplier,
            name: v.name,
            renewalPrice: v.renewalPrice,
            currencyCode: v.currencyCode,
            billingPeriod: v.billingPeriod,
            billingPeriodUnit: v.billingPeriodUnit,
            status: v.status,
            nextBillingAt: v.nextBillingAt,
          }
        : {};

    const [row] = await db
      .update(schema.supplierCosts)
      .set({
        ...editable,
        // True of both kinds: the sync cannot know which business pays, or how
        // VAT sits on the invoice.
        business: v.business,
        vatTreatment: v.vatTreatment,
        clientId: v.clientId,
        notes: v.notes,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.supplierCosts.id, v.id), eq(schema.supplierCosts.organisationId, organisationId)))
      .returning();

    await recordAudit(db, organisationId, {
      actorKind: "user",
      actorId: v.actorId,
      action: "cost.updated",
      targetType: "supplier_cost",
      targetId: v.id,
      before,
      after: row,
    });
    return row!;
  }

  const [row] = await db
    .insert(schema.supplierCosts)
    .values({
      organisationId,
      source: "manual",
      externalId: null,
      supplier: v.supplier,
      name: v.name,
      business: v.business,
      renewalPrice: v.renewalPrice,
      totalPrice: v.renewalPrice,
      currencyCode: v.currencyCode,
      billingPeriod: v.billingPeriod,
      billingPeriodUnit: v.billingPeriodUnit,
      vatTreatment: v.vatTreatment,
      status: v.status,
      nextBillingAt: v.nextBillingAt,
      clientId: v.clientId,
      notes: v.notes,
      // A typed row is attributed by the person typing it, so there is nothing
      // to suggest and nothing to confirm.
      match: v.clientId ? "confirmed" : "unassigned",
    })
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: v.actorId,
    action: "cost.created",
    targetType: "supplier_cost",
    targetId: row!.id,
    after: row,
  });
  return row!;
}

/**
 * Deletes a manual row.
 *
 * A synced row cannot be deleted — the next sync would recreate it, and a
 * delete that silently undoes itself is worse than a refused one. Mark it
 * cancelled at the supplier instead.
 */
export async function deleteCost(db: Db, organisationId: string, costId: string, actorId: string): Promise<void> {
  const [before] = await db
    .select()
    .from(schema.supplierCosts)
    .where(and(eq(schema.supplierCosts.id, costId), eq(schema.supplierCosts.organisationId, organisationId)));
  if (!before) throw new Error("that cost could not be found");
  if (before.source !== "manual") {
    throw new Error("that cost comes from a supplier sync and would come back — cancel it at the supplier instead");
  }

  await db
    .delete(schema.supplierCosts)
    .where(and(eq(schema.supplierCosts.id, costId), eq(schema.supplierCosts.organisationId, organisationId)));

  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId,
    action: "cost.deleted",
    targetType: "supplier_cost",
    targetId: costId,
    before,
  });
}

export interface RegisterEntry {
  id: string;
  source: "sync" | "manual";
  supplier: CostSupplier;
  name: string;
  business: CostBusiness;
  status: string;
  renewalPrice: number;
  currencyCode: string;
  billingPeriod: number;
  billingPeriodUnit: string;
  vatTreatment: VatTreatment;
  nextBillingAt: Date | null;
  clientId: string | null;
  notes: string | null;
  /** In the row's own currency, minor units. Converted to GBP at report time. */
  monthlyMinor: number;
  yearlyMinor: number;
}

/** Every row in the register, soonest renewal first, with its normalised figures. */
export async function listRegister(db: Db, organisationId: string): Promise<RegisterEntry[]> {
  const rows = await db
    .select()
    .from(schema.supplierCosts)
    .where(eq(schema.supplierCosts.organisationId, organisationId))
    .orderBy(asc(schema.supplierCosts.nextBillingAt), asc(schema.supplierCosts.name));

  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    supplier: row.supplier,
    name: row.name,
    business: row.business,
    status: row.status,
    renewalPrice: row.renewalPrice,
    currencyCode: row.currencyCode,
    billingPeriod: row.billingPeriod,
    billingPeriodUnit: row.billingPeriodUnit,
    vatTreatment: row.vatTreatment,
    nextBillingAt: row.nextBillingAt,
    clientId: row.clientId,
    notes: row.notes,
    monthlyMinor: monthlyMinor(row),
    yearlyMinor: yearlyMinor(row),
  }));
}

/**
 * The suppliers the code already knows it talks to, for pre-filling.
 *
 * Shoji corrects the numbers; the point is that he is correcting a list rather
 * than remembering one. `renewalPrice: 0` is honest — the code knows the
 * supplier exists because a key for it is configured, and knows nothing
 * whatsoever about the price.
 *
 * `business` is the best guess and is editable. Mapbox is Cabio's: it is in
 * the taxi platform, not in anything LaunchFlow bills for.
 */
export const KNOWN_SUPPLIERS: readonly {
  supplier: CostSupplier;
  name: string;
  business: CostBusiness;
  currencyCode: string;
  billingPeriodUnit: "month" | "year";
  vatTreatment: VatTreatment;
  notes: string;
}[] = [
  { supplier: "hetzner", name: "Hetzner — server", business: "shared", currencyCode: "EUR", billingPeriodUnit: "month", vatTreatment: "reverse_charge", notes: "Runs every app. Split across active clients by measured usage." },
  { supplier: "anthropic", name: "Anthropic — Claude API", business: "shared", currencyCode: "USD", billingPeriodUnit: "month", vatTreatment: "reverse_charge", notes: "Usage-based. Import the Console cost CSV monthly; api_key names the business." },
  { supplier: "openai", name: "OpenAI — API", business: "shared", currencyCode: "USD", billingPeriodUnit: "month", vatTreatment: "reverse_charge", notes: "Brief writer, site generator, post images. Usage-based." },
  { supplier: "postmark", name: "Postmark — email", business: "launchflow", currencyCode: "USD", billingPeriodUnit: "month", vatTreatment: "reverse_charge", notes: "Transactional email in and out." },
  { supplier: "screenshotone", name: "ScreenshotOne — site thumbnails", business: "launchflow", currencyCode: "USD", billingPeriodUnit: "month", vatTreatment: "reverse_charge", notes: "Daily website captures." },
  { supplier: "mapbox", name: "Mapbox — maps and routing", business: "cabio", currencyCode: "USD", billingPeriodUnit: "month", vatTreatment: "reverse_charge", notes: "Cabio's, not LaunchFlow's. Keep it off the LaunchFlow P&L." },
  { supplier: "twilio", name: "Twilio — SMS and WhatsApp", business: "launchflow", currencyCode: "USD", billingPeriodUnit: "month", vatTreatment: "reverse_charge", notes: "Not live yet — no account at the time of writing." },
  { supplier: "github", name: "GitHub", business: "shared", currencyCode: "USD", billingPeriodUnit: "month", vatTreatment: "reverse_charge", notes: "Every repository." },
  { supplier: "stripe", name: "Stripe — card fees", business: "launchflow", currencyCode: "GBP", billingPeriodUnit: "month", vatTreatment: "exempt", notes: "Percentage plus fixed. Read from balance transactions, not a subscription." },
  { supplier: "apple", name: "Apple Developer Program", business: "cabio", currencyCode: "GBP", billingPeriodUnit: "year", vatTreatment: "standard", notes: "The iOS app." },
  { supplier: "google", name: "Google Play Developer", business: "cabio", currencyCode: "GBP", billingPeriodUnit: "year", vatTreatment: "standard", notes: "One-off historically; kept here so it is not forgotten." },
  { supplier: "expo", name: "Expo — EAS builds", business: "cabio", currencyCode: "USD", billingPeriodUnit: "month", vatTreatment: "reverse_charge", notes: "Builds and submissions for the phone apps." },
  { supplier: "hostinger", name: "Hostinger — shared hosting", business: "launchflow", currencyCode: "USD", billingPeriodUnit: "year", vatTreatment: "standard", notes: "Domains sync themselves; this is the hosting plan." },
];

/**
 * Adds any known supplier that is not in the register yet, priced at zero.
 *
 * Idempotent: run it as often as you like and it only ever adds what is
 * missing, matched on supplier and name, so a row Shoji has renamed or priced
 * is never touched.
 */
export async function prefillRegister(db: Db, organisationId: string, actorId: string): Promise<{ added: number }> {
  const existing = await db
    .select({ supplier: schema.supplierCosts.supplier, name: schema.supplierCosts.name })
    .from(schema.supplierCosts)
    .where(eq(schema.supplierCosts.organisationId, organisationId));
  const have = new Set(existing.map((row) => `${row.supplier}::${row.name}`));

  let added = 0;
  for (const known of KNOWN_SUPPLIERS) {
    if (have.has(`${known.supplier}::${known.name}`)) continue;
    await upsertCost(db, organisationId, {
      supplier: known.supplier,
      name: known.name,
      business: known.business,
      renewalPrice: 0,
      currencyCode: known.currencyCode,
      billingPeriod: 1,
      billingPeriodUnit: known.billingPeriodUnit,
      vatTreatment: known.vatTreatment,
      status: "active",
      notes: known.notes,
      actorId,
    });
    added += 1;
  }
  return { added };
}

/** Rows nobody has priced yet — the "finish me" list on the Costs screen. */
export async function unpricedCosts(db: Db, organisationId: string): Promise<RegisterEntry[]> {
  const all = await listRegister(db, organisationId);
  return all.filter((row) => row.renewalPrice === 0 && row.status !== "cancelled");
}

/** Manual rows with no business set is not a state the enum allows; this finds ones still on the default. */
export async function costsWithoutClient(db: Db, organisationId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.supplierCosts.id })
    .from(schema.supplierCosts)
    .where(and(eq(schema.supplierCosts.organisationId, organisationId), isNull(schema.supplierCosts.clientId)));
  return rows.length;
}
