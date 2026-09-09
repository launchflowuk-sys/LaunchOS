import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { RegistrarAdapter } from "@launchos/integrations";
import { and, asc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { matchCostToDomain } from "./match-cost-to-domain.js";

/**
 * What LaunchFlow pays, filed against who it is paid for.
 *
 * The revenue side has always been here — packages, subscriptions, invoices.
 * The cost side lived in Hostinger's dashboard, in dollars, under product
 * names, so a client could show £950 of income and nothing at all about
 * whether that client made any money.
 *
 * The hard part is not the sync. It is that **a supplier's subscription is
 * named after the product, never the client**: `.LIVE Domain`, not
 * `cabio.live`. Nothing can be matched with certainty, so this guesses, marks
 * the guess as a guess, and lets a human confirm it — and never overwrites a
 * confirmation on a later run.
 */

export interface SyncSupplierCostsResult {
  reported: number;
  created: number;
  updated: number;
  /** Guesses made this run, for the log. */
  suggested: number;
}

/**
 * Pulls the supplier's subscriptions in and files them.
 *
 * Upserted on `(organisation, supplier, external_id)`, so this is safe to run
 * as often as you like. A row whose `match` is `confirmed` keeps its client:
 * the sync updates the money and the dates and never the attribution, because
 * a human has already answered the question it can only guess at.
 */
export async function syncSupplierCosts(
  db: Db,
  organisationId: string,
  registrar: RegistrarAdapter,
  now: Date = new Date(),
): Promise<SyncSupplierCostsResult> {
  const subscriptions = await registrar.listSubscriptions();

  // Every domain we hold, with the moment it was registered — which is what
  // actually resolves a line on the bill. See `matchCostToDomain`.
  const domains = await db
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      clientId: schema.domains.clientId,
      registeredAt: schema.domains.registeredAt,
    })
    .from(schema.domains)
    .where(eq(schema.domains.organisationId, organisationId));

  let created = 0;
  let updated = 0;
  let suggested = 0;

  for (const sub of subscriptions) {
    const [existing] = await db
      .select({ id: schema.supplierCosts.id, match: schema.supplierCosts.match })
      .from(schema.supplierCosts)
      .where(and(
        eq(schema.supplierCosts.organisationId, organisationId),
        eq(schema.supplierCosts.supplier, registrar.name === "hostinger" ? "hostinger" : "hostinger"),
        eq(schema.supplierCosts.externalId, sub.id),
      ));

    // The TLD alone could only ever narrow fifty-three rows to a shortlist:
    // seven `.co.uk` domains and seven `.CO.UK Domain` lines is a coin toss,
    // and a wrong cost on a client's margin is worse than none. The purchase
    // moment resolves it outright — see `matchCostToDomain`.
    const guess = matchCostToDomain({ name: sub.name, startedAt: sub.startedAt }, domains);

    const money = {
      name: sub.name,
      status: sub.status,
      renewalPrice: sub.renewalPrice,
      totalPrice: sub.totalPrice,
      currencyCode: sub.currencyCode,
      billingPeriod: sub.billingPeriod,
      billingPeriodUnit: sub.billingPeriodUnit,
      autoRenewed: sub.autoRenewed,
      nextBillingAt: sub.nextBillingAt,
      startedAt: sub.startedAt,
      seenAt: now,
      updatedAt: now,
    };

    if (!existing) {
      await db.insert(schema.supplierCosts).values({
        organisationId,
        supplier: "hostinger",
        externalId: sub.id,
        ...money,
        ...(guess ? { clientId: guess.clientId, domainId: guess.domainId, match: "suggested" as const } : {}),
      });
      created += 1;
      if (guess) suggested += 1;
      continue;
    }

    // The money always updates. The attribution only when nobody has confirmed
    // one — that is the whole point of the `confirmed` state.
    await db.update(schema.supplierCosts)
      .set({
        ...money,
        ...(existing.match === "confirmed" || !guess
          ? {}
          : { clientId: guess.clientId, domainId: guess.domainId, match: "suggested" as const }),
      })
      .where(eq(schema.supplierCosts.id, existing.id));
    updated += 1;
  }

  return { reported: subscriptions.length, created, updated, suggested };
}

export const AssignSupplierCostInput = z.object({
  costId: z.string().uuid(),
  /** Null detaches it, putting the row back in the unattributed pile. */
  clientId: z.string().uuid().nullable(),
  actorId: z.string().min(1),
});
export type AssignSupplierCostInput = z.input<typeof AssignSupplierCostInput>;

/** A human answering the question the sync can only guess at. Never undone by a sync. */
export async function assignSupplierCost(
  db: Db,
  organisationId: string,
  input: AssignSupplierCostInput,
): Promise<void> {
  const v = AssignSupplierCostInput.parse(input);
  const [before] = await db.select().from(schema.supplierCosts)
    .where(and(eq(schema.supplierCosts.id, v.costId), eq(schema.supplierCosts.organisationId, organisationId)));
  if (!before) throw new Error("that cost could not be found");

  await db.update(schema.supplierCosts)
    .set({
      clientId: v.clientId,
      // Detaching returns it to `unassigned` rather than leaving a confirmed
      // row pointing at nobody, which would then never be suggested again.
      match: v.clientId ? "confirmed" : "unassigned",
      ...(v.clientId ? {} : { domainId: null }),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.supplierCosts.id, v.costId), eq(schema.supplierCosts.organisationId, organisationId)));

  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "supplier_cost.assigned",
    targetType: "supplier_cost", targetId: v.costId,
    before: { clientId: before.clientId, match: before.match },
    after: { clientId: v.clientId, match: v.clientId ? "confirmed" : "unassigned" },
  });
}

export interface CostRow {
  id: string;
  name: string;
  status: string;
  renewalPrice: number;
  currencyCode: string;
  nextBillingAt: Date | null;
  autoRenewed: boolean;
  clientId: string | null;
  clientName: string | null;
  /**
   * The domain this line pays for, once something has worked it out. The
   * column existed from the start and was never read back, so the screen kept
   * showing `.CO.UK Domain` when the row already knew it meant
   * `graystowntaxis.co.uk`.
   */
  domainName: string | null;
  /** When the supplier started it — what the resolution is derived from. */
  startedAt: Date | null;
  match: "unassigned" | "suggested" | "confirmed";
}

/** Every cost, newest billing first, with the client it is attributed to. */
export async function listSupplierCosts(db: Db, organisationId: string): Promise<CostRow[]> {
  return db
    .select({
      id: schema.supplierCosts.id,
      name: schema.supplierCosts.name,
      status: schema.supplierCosts.status,
      renewalPrice: schema.supplierCosts.renewalPrice,
      currencyCode: schema.supplierCosts.currencyCode,
      nextBillingAt: schema.supplierCosts.nextBillingAt,
      autoRenewed: schema.supplierCosts.autoRenewed,
      clientId: schema.supplierCosts.clientId,
      clientName: schema.clients.name,
      domainName: schema.domains.name,
      startedAt: schema.supplierCosts.startedAt,
      match: schema.supplierCosts.match,
    })
    .from(schema.supplierCosts)
    .leftJoin(schema.clients, eq(schema.supplierCosts.clientId, schema.clients.id))
    .leftJoin(schema.domains, eq(schema.supplierCosts.domainId, schema.domains.id))
    .where(eq(schema.supplierCosts.organisationId, organisationId))
    .orderBy(asc(schema.supplierCosts.nextBillingAt));
}

/** What one client costs, by currency — the figure the Payments screen reads against revenue. */
export async function clientCostByCurrency(
  db: Db,
  organisationId: string,
  clientId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      currency: schema.supplierCosts.currencyCode,
      total: sql<number>`sum(${schema.supplierCosts.renewalPrice})`,
    })
    .from(schema.supplierCosts)
    .where(and(
      eq(schema.supplierCosts.organisationId, organisationId),
      eq(schema.supplierCosts.clientId, clientId),
      // A cancelled subscription is not a forward cost.
      sql`${schema.supplierCosts.status} <> 'cancelled'`,
    ))
    .groupBy(schema.supplierCosts.currencyCode);
  return Object.fromEntries(rows.map((row) => [row.currency, Number(row.total ?? 0)]));
}

/**
 * Anything that takes money in the next `days`, soonest first.
 *
 * `in_trial` rows are the ones worth catching: a trial that renews is a charge
 * nobody planned for, and three of them on this account are set to renew.
 */
export async function upcomingCosts(
  db: Db,
  organisationId: string,
  days = 45,
  now: Date = new Date(),
): Promise<CostRow[]> {
  const until = new Date(now.getTime() + days * 86_400_000);
  return db
    .select({
      id: schema.supplierCosts.id,
      name: schema.supplierCosts.name,
      status: schema.supplierCosts.status,
      renewalPrice: schema.supplierCosts.renewalPrice,
      currencyCode: schema.supplierCosts.currencyCode,
      nextBillingAt: schema.supplierCosts.nextBillingAt,
      autoRenewed: schema.supplierCosts.autoRenewed,
      clientId: schema.supplierCosts.clientId,
      clientName: schema.clients.name,
      domainName: schema.domains.name,
      startedAt: schema.supplierCosts.startedAt,
      match: schema.supplierCosts.match,
    })
    .from(schema.supplierCosts)
    .leftJoin(schema.clients, eq(schema.supplierCosts.clientId, schema.clients.id))
    .leftJoin(schema.domains, eq(schema.supplierCosts.domainId, schema.domains.id))
    .where(and(
      eq(schema.supplierCosts.organisationId, organisationId),
      isNotNull(schema.supplierCosts.nextBillingAt),
      gte(schema.supplierCosts.nextBillingAt, now),
      lte(schema.supplierCosts.nextBillingAt, until),
      sql`${schema.supplierCosts.status} <> 'cancelled'`,
    ))
    .orderBy(asc(schema.supplierCosts.nextBillingAt));
}
