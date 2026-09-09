import { z } from "zod";
import { DnsApiError, DnsHttpClient, type DnsHttpOptions } from "../dns/http.js";
import type { DomainAvailability, RegistrarAdapter, RegistrarDomain, SupplierSubscription } from "./types.js";

/**
 * Hostinger's domain portfolio, read-only.
 *
 * `GET /api/domains/v1/portfolio` returns every domain on the account with its
 * expiry. That is the whole integration: LaunchOS never buys, transfers or
 * renews through it, so there is no write path here to get wrong.
 *
 * It reuses the DNS client's HTTP shell — same bearer token, same single retry
 * on 429, same classified errors — because it is the same account and the same
 * `HOSTINGER_API_TOKEN`. A separate base URL is the only difference: domains
 * and DNS are different services under the same developer API.
 */

const DEFAULT_BASE_URL = "https://developers.hostinger.com/api/domains/v1";
/** Billing lives under its own service on the same developer API and the same token. */
const DEFAULT_BILLING_URL = "https://developers.hostinger.com/api/billing/v1";

const SubscriptionEntry = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1),
  renewal_price: z.number().nullish(),
  total_price: z.number().nullish(),
  currency_code: z.string().nullish(),
  billing_period: z.number().nullish(),
  billing_period_unit: z.string().nullish(),
  is_auto_renewed: z.boolean().nullish(),
  next_billing_at: z.string().nullish(),
});
const Subscriptions = z.union([z.array(SubscriptionEntry), z.object({ data: z.array(SubscriptionEntry) })]);

/**
 * Availability comes back in more than one shape depending on the TLD, so this
 * is read leniently: the only field that must be present is whether the name
 * is free.
 */
const AvailabilityEntry = z.object({
  domain: z.string().nullish(),
  is_available: z.boolean().nullish(),
  available: z.boolean().nullish(),
  is_premium: z.boolean().nullish(),
  price: z.number().nullish(),
  currency_code: z.string().nullish(),
});
const Availability = z.union([
  z.array(AvailabilityEntry),
  z.object({ data: z.array(AvailabilityEntry) }),
  AvailabilityEntry,
]);

/**
 * Parsed leniently on purpose. This is somebody else's API and the only field
 * we truly need is the name; a portfolio entry with an expiry we cannot read
 * is still worth returning as "known domain, unknown date" rather than
 * throwing the whole sync away over one row.
 */
const PortfolioEntry = z.object({
  domain: z.string().min(1),
  expires_at: z.string().nullish(),
  status: z.string().nullish(),
  is_auto_renew_enabled: z.boolean().nullish(),
  auto_renew: z.boolean().nullish(),
});

const Portfolio = z.union([
  z.array(PortfolioEntry),
  z.object({ data: z.array(PortfolioEntry) }),
]);

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

export class HostingerRegistrarAdapter implements RegistrarAdapter {
  readonly name = "hostinger" as const;

  private readonly http: DnsHttpClient;
  private readonly baseUrl: string;
  private readonly billingUrl: string;

  constructor(options: DnsHttpOptions & { billingUrl?: string }) {
    this.http = new DnsHttpClient("hostinger-domains", options);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.billingUrl = (options.billingUrl ?? DEFAULT_BILLING_URL).replace(/\/+$/, "");
  }

  /**
   * What LaunchFlow pays. Amounts are passed through in the supplier's own
   * currency and minor unit — this adapter converts nothing, because a rate
   * applied here cannot be re-read later or checked against their invoice.
   */
  async listSubscriptions(): Promise<SupplierSubscription[]> {
    const response = await this.http.send<unknown>("GET", `${this.billingUrl}/subscriptions`);
    const parsed = Subscriptions.safeParse(response.body);
    if (!parsed.success) {
      throw new DnsApiError("hostinger-domains", "malformed", "the subscriptions response was not the expected shape");
    }
    const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
    return entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      status: entry.status,
      renewalPrice: entry.renewal_price ?? 0,
      totalPrice: entry.total_price ?? 0,
      currencyCode: entry.currency_code ?? "USD",
      billingPeriod: entry.billing_period ?? 1,
      billingPeriodUnit: entry.billing_period_unit ?? "year",
      // Absent reads as true: everything on this account renews by default, and
      // assuming a subscription will silently stop is the costlier mistake.
      autoRenewed: entry.is_auto_renewed ?? true,
      nextBillingAt: toDate(entry.next_billing_at),
    }));
  }

  async checkAvailability(name: string): Promise<DomainAvailability> {
    const wanted = name.trim().toLowerCase().replace(/\.$/, "");
    const response = await this.http.send<unknown>(
      "POST",
      `${this.baseUrl}/availability`,
      { domain: wanted.split(".")[0], tlds: [wanted.split(".").slice(1).join(".")], with_alternatives: false },
    );
    const parsed = Availability.safeParse(response.body);
    if (!parsed.success) {
      throw new DnsApiError("hostinger-domains", "malformed", "the availability response was not the expected shape");
    }
    const rows = Array.isArray(parsed.data)
      ? parsed.data
      : "data" in parsed.data ? parsed.data.data : [parsed.data];
    const hit = rows.find((row) => (row.domain ?? wanted).toLowerCase() === wanted) ?? rows[0];
    return {
      name: wanted,
      // Absent reads as *unavailable*: telling somebody a name is free when we
      // do not know is the answer that wastes their afternoon.
      available: hit?.is_available ?? hit?.available ?? false,
      price: hit?.price ?? null,
      currencyCode: hit?.currency_code ?? null,
      premium: hit?.is_premium ?? false,
    };
  }

  async listDomains(): Promise<RegistrarDomain[]> {
    const response = await this.http.send<unknown>("GET", `${this.baseUrl}/portfolio`);
    if (response.status === 404) {
      throw new DnsApiError("hostinger-domains", "http", "the portfolio endpoint was not found", 404);
    }
    const parsed = Portfolio.safeParse(response.body);
    if (!parsed.success) {
      throw new DnsApiError("hostinger-domains", "malformed", "the portfolio response was not the expected shape");
    }
    const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;

    const domains = entries.map((entry) => ({
      // Lower-cased and de-dotted so it compares against `domains.name`
      // without every caller remembering to.
      name: entry.domain.trim().toLowerCase().replace(/\.$/, ""),
      expiresAt: toDate(entry.expires_at),
      // Hostinger's portfolio carries no auto-renew field at all today — this
      // is checked against the live response, not assumed. Two spellings are
      // accepted in case one appears; `null` means "not stated", which the
      // sync treats as "leave whatever is on the record alone" rather than as
      // "auto-renew is off".
      autoRenew: entry.is_auto_renew_enabled ?? entry.auto_renew ?? null,
      status: entry.status ?? null,
    }));

    // A name can appear twice. A domain that came free with hosting is listed
    // as its own entry with `expires_at: null` *beside* the real registration —
    // `shayanchaudary.com` on this account is both — so a plain last-wins map
    // would hand back the dateless one about half the time and the domain would
    // silently never get a renewal date. The entry that actually knows when it
    // expires is the one worth keeping.
    const best = new Map<string, RegistrarDomain>();
    for (const domain of domains) {
      const held = best.get(domain.name);
      if (!held || (held.expiresAt === null && domain.expiresAt !== null)) best.set(domain.name, domain);
    }
    return [...best.values()];
  }
}

/** The real adapter when a token exists, the mock otherwise. Constructs only — no request here. */
export function createRegistrarAdapterFromEnv(env: NodeJS.ProcessEnv): RegistrarAdapter | null {
  const token = env["HOSTINGER_API_TOKEN"];
  if (!token) return null;
  return new HostingerRegistrarAdapter({
    token,
    ...(env["HOSTINGER_DOMAINS_API_URL"] ? { baseUrl: env["HOSTINGER_DOMAINS_API_URL"] } : {}),
  });
}
