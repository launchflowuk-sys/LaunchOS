import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsCatalogItem, PaymentsSubscriptionDetail } from "@launchos/integrations";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

/**
 * The pure half of the Stripe sync: which products look like ours, what a
 * package should be priced at, what a Stripe customer should be called, and
 * how a subscription finds its client. No writes here.
 */

/** Product names that are LaunchFlow's without carrying the brand word. */
const KNOWN_PLAN_NAMES: ReadonlySet<string> = new Set(["starter plan", "standard plan", "premium plan"]);

/**
 * Pre-ticked on the review screen: anything with "launchflow" in the name,
 * plus the three unbranded plan names the agency sells. A product the owner
 * previously left unticked stays unticked, whatever its name.
 */
export function isSuggestedProduct(productName: string, ignoredProductIds: readonly string[], productId: string): boolean {
  if (ignoredProductIds.includes(productId)) return false;
  const name = productName.trim().toLowerCase();
  return name.includes("launchflow") || KNOWN_PLAN_NAMES.has(name);
}

/**
 * The price a package is created from: the cheapest monthly one, or failing
 * a monthly price the cheapest of any interval. Null for a product with no
 * prices at all (cannot happen from `listCatalog`, which walks prices).
 */
export function preferredPrice(prices: readonly PaymentsCatalogItem[]): PaymentsCatalogItem | null {
  const cheapest = (items: readonly PaymentsCatalogItem[]) =>
    items.reduce<PaymentsCatalogItem | null>((best, item) => (best === null || item.amountPence < best.amountPence ? item : best), null);
  const monthly = prices.filter((p) => p.interval === "month" && p.intervalCount === 1);
  return cheapest(monthly) ?? cheapest(prices);
}

/** What a price costs per month: a £120 quarter is £40 a month, a £600 year £50. */
export function monthlyEquivalentPence(price: PaymentsCatalogItem): number {
  const months = { day: 1 / 30, week: 12 / 52, month: 1, year: 12 }[price.interval] * price.intervalCount;
  return Math.round(price.amountPence / months);
}

const SMALL_WORDS: ReadonlySet<string> = new Set(["and", "of", "the", "for", "&"]);
const ACRONYMS: Readonly<Record<string, string>> = { ltd: "Ltd", llp: "LLP", plc: "PLC", uk: "UK", cic: "CIC" };

/**
 * "Lakeside and Purfleet Taxis ltd" → "Lakeside and Purfleet Taxis Ltd";
 * "Monika  Obidzinska" → "Monika Obidzinska". A name is capitalised by word,
 * joining words stay lower, the company suffixes take their usual form, and
 * doubled spaces collapse. A word already carrying mixed case ("CabLine",
 * "iPhone Repairs") is left as typed.
 */
export function businessCase(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (ACRONYMS[lower]) return ACRONYMS[lower];
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      if (word !== lower && word !== word.toUpperCase()) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** The client name a Stripe subscription proposes, in order of what is known about the customer. */
export function proposedClientName(detail: Pick<PaymentsSubscriptionDetail, "customerId" | "customerName" | "customerEmail">): string {
  const named = detail.customerName ? businessCase(detail.customerName) : "";
  if (named) return named;
  const localPart = detail.customerEmail?.split("@")[0]?.trim();
  if (localPart) return businessCase(localPart.replace(/[._-]+/g, " "));
  return `Stripe customer ${detail.customerId}`;
}

const Email = z.string().trim().email().max(320);

/** The email as the sync compares and stores it, or undefined when Stripe holds nothing usable. */
export function normalisedEmail(email: string | null | undefined): string | undefined {
  const parsed = Email.safeParse(email ?? "");
  return parsed.success ? parsed.data.toLowerCase() : undefined;
}

export interface KnownClient {
  clientId: string;
  name: string;
}

export type ClientMatch = (KnownClient & { matchedBy: "billing_profile" | "email" }) | null;

/**
 * Every way a Stripe customer can already be a LaunchOS client, loaded once
 * per run: the billing profile that carries the customer id, the client's own
 * email, and the emails of its portal users. Clients created during the run
 * are registered so a customer with two subscriptions gets one client.
 */
export class ClientIndex {
  private readonly byCustomerId = new Map<string, KnownClient>();
  private readonly byEmail = new Map<string, KnownClient>();

  static async load(db: Db, organisationId: string): Promise<ClientIndex> {
    const index = new ClientIndex();
    const clients = await db
      .select({ id: schema.clients.id, name: schema.clients.name, email: schema.clients.email })
      .from(schema.clients)
      .where(and(eq(schema.clients.organisationId, organisationId), isNull(schema.clients.deletedAt)));
    const names = new Map(clients.map((c) => [c.id, c.name]));
    for (const client of clients) {
      index.registerEmail(client.email, { clientId: client.id, name: client.name });
    }
    const profiles = await db
      .select({ clientId: schema.billingProfiles.clientId, stripeCustomerId: schema.billingProfiles.stripeCustomerId })
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.organisationId, organisationId));
    for (const profile of profiles) {
      const name = names.get(profile.clientId);
      if (profile.stripeCustomerId && name !== undefined) {
        index.byCustomerId.set(profile.stripeCustomerId, { clientId: profile.clientId, name });
      }
    }
    const portalUsers = await db
      .select({ clientId: schema.clientUsers.clientId, email: schema.user.email })
      .from(schema.clientUsers)
      .innerJoin(schema.user, eq(schema.user.id, schema.clientUsers.userId))
      .where(eq(schema.clientUsers.organisationId, organisationId));
    for (const portalUser of portalUsers) {
      const name = names.get(portalUser.clientId);
      if (name !== undefined) index.registerEmail(portalUser.email, { clientId: portalUser.clientId, name });
    }
    return index;
  }

  /** A client's own email wins over a portal user's when both are set; the first registration stays. */
  private registerEmail(email: string | null | undefined, client: KnownClient): void {
    const key = normalisedEmail(email);
    if (key && !this.byEmail.has(key)) this.byEmail.set(key, client);
  }

  match(detail: Pick<PaymentsSubscriptionDetail, "customerId" | "customerEmail">): ClientMatch {
    const byProfile = this.byCustomerId.get(detail.customerId);
    if (byProfile) return { ...byProfile, matchedBy: "billing_profile" };
    const key = normalisedEmail(detail.customerEmail);
    const byEmail = key ? this.byEmail.get(key) : undefined;
    return byEmail ? { ...byEmail, matchedBy: "email" } : null;
  }

  /** A client the run just created, or just linked to a customer id. */
  register(customerId: string, email: string | undefined, client: KnownClient): void {
    this.byCustomerId.set(customerId, client);
    this.registerEmail(email, client);
  }
}
