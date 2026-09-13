import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { missingRates, ratesForCurrencies, REPORTING_CURRENCY } from "./fx.js";
import { convert } from "./normalise.js";
import { listRegister } from "./register.js";
import { clientUsagePence } from "./usage.js";

/**
 * What one client is worth, for a month.
 *
 * Four numbers, and the third is the one that took a schema to answer:
 *
 * - **Revenue** — invoices they actually paid. Collected, not billed.
 * - **Direct cost** — register rows attributed to them: their domains, their
 *   hosting.
 * - **Usage** — metered calls made on their behalf. The images for their posts,
 *   the tokens that wrote their brief, their site generation.
 * - **Shared** — their slice of the costs nobody can attribute: the servers,
 *   GitHub. Split by measured usage, which is Shoji's call and the only split
 *   that is not arbitrary.
 *
 * The shared split is the honest part and the part worth understanding. A
 * client who generates forty images a month genuinely leans on the server
 * harder than one who gets a static page, and splitting evenly would flatter
 * the expensive client at the cheap one's expense. When nothing is metered at
 * all the split falls back to even, because dividing by zero usage would put
 * the entire server bill on whoever happened to be first.
 */

export interface ClientProfit {
  clientId: string;
  month: string;
  /** Collected, ex-VAT, GBP pence. */
  revenueNetPence: number;
  /** Register rows attributed to this client, GBP pence a month. */
  directCostPence: number;
  /** Metered calls made for them this month. */
  usageCostPence: number;
  /** Their slice of the unattributable costs. */
  sharedCostPence: number;
  totalCostPence: number;
  marginPence: number;
  /** Their share of all metered usage, 0–1. What the shared split is based on. */
  usageShare: number;
  /** True when the shared split fell back to even because nothing was metered. */
  sharedSplitEven: boolean;
  /** Currencies that could not be converted, so direct cost is understated. */
  missingRateCurrencies: string[];
}

/** Collected revenue for one client in a window, net of the VAT actually charged. */
async function clientRevenue(db: Db, organisationId: string, clientId: string, from: Date, to: Date): Promise<number> {
  const [row] = await db
    .select({
      gross: sql<string>`coalesce(sum(${schema.invoices.totalPence}), 0)`,
      vat: sql<string>`coalesce(sum(${schema.invoices.vatPence}), 0)`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organisationId, organisationId),
        eq(schema.invoices.clientId, clientId),
        eq(schema.invoices.status, "paid"),
        isNotNull(schema.invoices.paidAt),
        gte(schema.invoices.paidAt, from),
        lt(schema.invoices.paidAt, to),
      ),
    );
  return Number(row?.gross ?? 0) - Number(row?.vat ?? 0);
}

/** Every client with usage this month, and the total — what the shared split divides by. */
async function usageShares(db: Db, organisationId: string, from: Date, to: Date) {
  const rows = await db
    .select({
      clientId: schema.usageEvents.clientId,
      pence: sql<string>`coalesce(sum(${schema.usageEvents.costPence}), 0)`,
    })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.organisationId, organisationId),
        gte(schema.usageEvents.occurredAt, from),
        lt(schema.usageEvents.occurredAt, to),
      ),
    )
    .groupBy(schema.usageEvents.clientId);

  // Only usage that belongs to a client counts towards the split. Company-wide
  // work is part of what is being shared out, not a share of it.
  const attributed = rows.filter((row) => row.clientId !== null);
  return {
    total: attributed.reduce((sum, row) => sum + Number(row.pence), 0),
    clients: new Map(attributed.map((row) => [row.clientId!, Number(row.pence)])),
  };
}

/** How many clients the shared cost is spread across when nothing is metered. */
async function activeClientCount(db: Db, organisationId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.status, "active")));
  return Math.max(1, Number(row?.n ?? 1));
}

export async function clientProfit(
  db: Db,
  organisationId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<ClientProfit> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const [revenue, register, usagePence, shares, clientCount] = await Promise.all([
    clientRevenue(db, organisationId, clientId, from, to),
    listRegister(db, organisationId),
    clientUsagePence(db, organisationId, clientId, now),
    usageShares(db, organisationId, from, to),
    activeClientCount(db, organisationId),
  ]);

  const currencies = register.map((row) => row.currencyCode);
  const rates = await ratesForCurrencies(db, organisationId, currencies, from);
  const missing = missingRates(currencies, rates);

  const toPence = (row: (typeof register)[number]) => {
    const currency = row.currencyCode.toUpperCase();
    if (currency !== REPORTING_CURRENCY && rates[currency] === undefined) return 0;
    return convert(row.monthlyMinor, currency, REPORTING_CURRENCY, currency === REPORTING_CURRENCY ? 1_000_000 : rates[currency]!);
  };

  const directCostPence = register.filter((row) => row.clientId === clientId).reduce((sum, row) => sum + toPence(row), 0);

  // Everything nobody has attributed to a client: the servers, GitHub, the
  // tooling. This is the pool being split.
  const sharedPool = register.filter((row) => row.clientId === null).reduce((sum, row) => sum + toPence(row), 0);

  const sharedSplitEven = shares.total === 0;
  const usageShare = sharedSplitEven ? 1 / clientCount : usagePence / shares.total;
  const sharedCostPence = Math.round(sharedPool * usageShare);

  const totalCostPence = directCostPence + usagePence + sharedCostPence;

  return {
    clientId,
    month: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, "0")}`,
    revenueNetPence: revenue,
    directCostPence,
    usageCostPence: usagePence,
    sharedCostPence,
    totalCostPence,
    marginPence: revenue - totalCostPence,
    usageShare,
    sharedSplitEven,
    missingRateCurrencies: missing,
  };
}
