import { schema, type Db } from "@launchos/db";
import type { EmailSubscription, HostingerMailClient, MailOrder } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { missingRates, ratesForCurrencies, REPORTING_CURRENCY } from "../costs/fx.js";
import { convert, monthlyMinor } from "../costs/normalise.js";

/**
 * Every Hostinger mailbox on a website's domains, and what the plan behind
 * them costs — for the Email section of the admin website page.
 *
 * Read-only and computed on request: nothing here is stored, so there is no
 * record to audit and nothing to go stale.
 *
 * **Cost is matched, never guessed.** A Hostinger subscription carries no
 * domain; the only link to its email order is that both expire at the same
 * moment. So a subscription is paired with an order only when exactly one
 * email subscription expires within 48 hours of it *and* no other order on the
 * account claims that subscription too. Anything else is "unknown", shown as
 * such, because a plausible wrong price is worse than an honest blank.
 */

const MATCH_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Storage at or past these fractions is orange, then red. Mirrored by the UI. */
export const STORAGE_WARN_PCT = 70;
export const STORAGE_FULL_PCT = 90;

export interface SiteEmailCost {
  currency: string;
  /** One billing period's renewal price, supplier minor units. */
  renewalMinor: number;
  billingPeriod: number;
  billingPeriodUnit: string;
  monthlyCostMinor: number;
  /** Null when there is no stored rate — never converted at 1.0. */
  monthlyCostGbpMinor: number | null;
  /** Monthly cost spread over the mailboxes actually in use; null with none. */
  perMailboxMonthlyMinor: number | null;
  perMailboxMonthlyGbpMinor: number | null;
  autoRenewed: boolean;
}

export interface SiteMailbox {
  address: string;
  status: string;
  storageUsedKb: number;
  storageQuotaKb: number;
  /** 0–100, null when the quota is unknown. */
  storagePct: number | null;
  messagesUsed: number;
  messagesQuota: number;
  monthlyShareMinor: number | null;
  monthlyShareGbpMinor: number | null;
}

export interface SiteEmailOrder {
  orderId: string;
  domain: string;
  planTitle: string;
  status: string;
  isTrial: boolean;
  seats: number;
  used: number;
  /** Null when no subscription could be matched with certainty. */
  cost: SiteEmailCost | null;
  /** When the next charge lands: the subscription's billing date, else the order's expiry. */
  renewsAt: Date | null;
  expiresAt: Date | null;
  mailboxes: SiteMailbox[];
}

export type SiteEmailSummary =
  | {
      ok: true;
      domains: string[];
      orders: SiteEmailOrder[];
      totals: {
        mailboxes: number;
        seats: number;
        /** What is paid today, in GBP: trials count as 0. Null if any paid order's cost is unknown. */
        monthlyCostGbpMinor: number | null;
      };
      /** Currencies with no stored rate, for "add a USD rate" guidance. */
      missingRate: string[];
    }
  | { ok: false; reason: "not_found" | "not_configured" | "provider"; message: string };

export interface SiteEmailDeps {
  mail: HostingerMailClient | null;
  now?: Date;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/** The one subscription for this order, or null when there is none or more than one candidate. */
function matchSubscription(
  target: MailOrder,
  allOrders: readonly MailOrder[],
  subs: readonly EmailSubscription[],
): EmailSubscription | null {
  const near = (a: Date | null, b: Date | null) => a !== null && b !== null && Math.abs(a.getTime() - b.getTime()) <= MATCH_WINDOW_MS;
  const candidates = subs.filter((s) => near(s.expiresAt, target.expiresAt));
  if (candidates.length !== 1) return null;
  const claimants = allOrders.filter((o) => near(o.expiresAt, candidates[0]!.expiresAt));
  return claimants.length === 1 ? candidates[0]! : null;
}

function share(amount: number | null, used: number): number | null {
  return amount === null || used === 0 ? null : Math.round(amount / used);
}

function costFor(sub: EmailSubscription, used: number, rates: Record<string, number>): SiteEmailCost | null {
  const monthly = monthlyMinor({ ...sub, vatTreatment: "none", status: "active" });
  if (monthly === 0 && sub.renewalPrice > 0) return null; // a period it cannot read
  const currency = sub.currencyCode.toUpperCase();
  const rate = rates[currency];
  const gbp = currency === REPORTING_CURRENCY ? monthly : rate === undefined ? null : convert(monthly, currency, REPORTING_CURRENCY, rate);
  return {
    currency,
    renewalMinor: sub.renewalPrice,
    billingPeriod: sub.billingPeriod,
    billingPeriodUnit: sub.billingPeriodUnit,
    monthlyCostMinor: monthly,
    monthlyCostGbpMinor: gbp,
    perMailboxMonthlyMinor: share(monthly, used),
    perMailboxMonthlyGbpMinor: share(gbp, used),
    autoRenewed: sub.autoRenewed,
  };
}

async function siteDomainNames(db: Db, organisationId: string, siteId: string): Promise<string[] | null> {
  const [site] = await db
    .select({ primaryUrl: schema.sites.primaryUrl })
    .from(schema.sites)
    .where(and(eq(schema.sites.organisationId, organisationId), eq(schema.sites.id, siteId)));
  if (!site) return null;
  const rows = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(and(eq(schema.domains.organisationId, organisationId), eq(schema.domains.siteId, siteId)));
  const names = [hostOf(site.primaryUrl), ...rows.map((r) => r.name.trim().toLowerCase().replace(/\.$/, ""))];
  return [...new Set(names.filter((n): n is string => Boolean(n)))];
}

export async function siteEmailSummary(
  db: Db,
  organisationId: string,
  siteId: string,
  deps: SiteEmailDeps,
): Promise<SiteEmailSummary> {
  const domains = await siteDomainNames(db, organisationId, siteId);
  if (!domains) return { ok: false, reason: "not_found", message: "Website not found." };
  if (!deps.mail) {
    return { ok: false, reason: "not_configured", message: "Hostinger email is not connected (HOSTINGER_API_TOKEN is unset)." };
  }
  const mail = deps.mail;

  try {
    const allOrders = await mail.listOrders();
    const mine = allOrders.filter((o) => domains.includes(o.domain));
    const [subs, boxesPerOrder] = await Promise.all([
      mine.length > 0 ? mail.listEmailSubscriptions() : Promise.resolve([]),
      Promise.all(mine.map((o) => mail.listMailboxes(o.id))),
    ]);
    const matched = mine.map((o) => matchSubscription(o, allOrders, subs));
    const currencies = matched.flatMap((s) => (s ? [s.currencyCode] : []));
    const rates = await ratesForCurrencies(db, organisationId, currencies, deps.now ?? new Date());

    const orders: SiteEmailOrder[] = mine.map((o, i) => {
      const boxes = boxesPerOrder[i]!;
      const sub = matched[i] ?? null;
      const cost = sub ? costFor(sub, boxes.length, rates) : null;
      return {
        orderId: o.id,
        domain: o.domain,
        planTitle: o.planTitle,
        status: o.status,
        isTrial: o.isTrial || sub?.status === "in_trial",
        seats: o.seats,
        used: boxes.length,
        cost,
        renewsAt: sub?.nextBillingAt ?? o.expiresAt,
        expiresAt: o.expiresAt,
        mailboxes: boxes.map((b) => ({
          address: b.address,
          status: b.status,
          storageUsedKb: b.storageUsedKb,
          storageQuotaKb: b.storageQuotaKb,
          storagePct: b.storageQuotaKb > 0 ? Math.min(100, Math.round((b.storageUsedKb / b.storageQuotaKb) * 100)) : null,
          messagesUsed: b.messagesUsed,
          messagesQuota: b.messagesQuota,
          monthlyShareMinor: cost?.perMailboxMonthlyMinor ?? null,
          monthlyShareGbpMinor: cost?.perMailboxMonthlyGbpMinor ?? null,
        })),
      };
    });

    const paidNow = orders.filter((o) => !o.isTrial);
    const monthlyCostGbpMinor = paidNow.some((o) => o.cost?.monthlyCostGbpMinor == null)
      ? null
      : paidNow.reduce((sum, o) => sum + o.cost!.monthlyCostGbpMinor!, 0);

    return {
      ok: true,
      domains,
      orders,
      totals: {
        mailboxes: orders.reduce((sum, o) => sum + o.used, 0),
        seats: orders.reduce((sum, o) => sum + o.seats, 0),
        monthlyCostGbpMinor,
      },
      missingRate: missingRates(currencies, rates),
    };
  } catch (error) {
    return { ok: false, reason: "provider", message: error instanceof Error ? error.message : "Hostinger email could not be read." };
  }
}
