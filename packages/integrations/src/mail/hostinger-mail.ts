import { z } from "zod";
import { DnsApiError, DnsHttpClient, type DnsFetch } from "../dns/http.js";

/**
 * Hostinger business email, read-only: which mailboxes exist on which domain,
 * how full they are, and what the plan behind them costs.
 *
 * Same account and same `HOSTINGER_API_TOKEN` as the DNS and registrar
 * adapters, so it rides the same HTTP shell (bearer token, one 429 retry,
 * classified errors that never carry the token).
 *
 * Nothing links an email order to its bill: a subscription has no domain. The
 * two share an expiry to the second, so matching them is the caller's job
 * (`packages/core/src/email-hosting`), not something guessed here.
 */

const DEFAULT_BASE_URL = "https://developers.hostinger.com";
/** A runaway `meta` must not turn one page view into a thousand requests. */
const MAX_PAGES = 50;
const PROVIDER = "hostinger-mail";

export interface MailOrder {
  id: string;
  status: string;
  isTrial: boolean;
  /** Mailboxes paid for. */
  seats: number;
  /** Lower-cased, no trailing dot — compares against `domains.name`. */
  domain: string;
  planTitle: string;
  createdAt: Date | null;
  expiresAt: Date | null;
}

export interface MailboxUsage {
  id: string;
  address: string;
  status: string;
  storageUsedKb: number;
  storageQuotaKb: number;
  messagesUsed: number;
  messagesQuota: number;
}

export interface EmailSubscription {
  id: string;
  name: string;
  status: string;
  /** Minor units (cents) in `currencyCode`, for one billing period. */
  renewalPrice: number;
  currencyCode: string;
  billingPeriod: number;
  billingPeriodUnit: string;
  autoRenewed: boolean;
  expiresAt: Date | null;
  nextBillingAt: Date | null;
}

export interface HostingerMailClient {
  readonly name: "hostinger" | "mock";
  /** Every email order on the account, across all pages. */
  listOrders(): Promise<MailOrder[]>;
  listMailboxes(orderId: string): Promise<MailboxUsage[]>;
  /** Only the subscriptions whose name says they are business email. */
  listEmailSubscriptions(): Promise<EmailSubscription[]>;
}

const OrderEntry = z.object({
  id: z.union([z.string(), z.number()]),
  status: z.string().nullish(),
  is_trial: z.boolean().nullish(),
  seats: z.number().nullish(),
  domain: z.object({ name: z.string().min(1) }),
  plan: z.object({ name: z.string().nullish(), title: z.string().nullish() }).nullish(),
  created_at: z.string().nullish(),
  expires_at: z.string().nullish(),
});
const OrdersPage = z.object({
  data: z.array(OrderEntry),
  meta: z.object({ current_page: z.number().nullish(), per_page: z.number().nullish(), total: z.number().nullish() }).nullish(),
});

const MailboxEntry = z.object({
  id: z.union([z.string(), z.number()]),
  address: z.string().min(1),
  status: z.string().nullish(),
  usage: z
    .object({
      storage_used: z.number().nullish(),
      storage_quota: z.number().nullish(),
      messages_used: z.number().nullish(),
      messages_quota: z.number().nullish(),
    })
    .nullish(),
});
const Mailboxes = z.union([z.array(MailboxEntry), z.object({ data: z.array(MailboxEntry) })]);

const SubscriptionEntry = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().min(1),
  status: z.string().nullish(),
  renewal_price: z.number().nullish(),
  currency_code: z.string().nullish(),
  billing_period: z.number().nullish(),
  billing_period_unit: z.string().nullish(),
  is_auto_renewed: z.boolean().nullish(),
  expires_at: z.string().nullish(),
  next_billing_at: z.string().nullish(),
});
const Subscriptions = z.union([z.array(SubscriptionEntry), z.object({ data: z.array(SubscriptionEntry) })]);

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function malformed(what: string): DnsApiError {
  return new DnsApiError(PROVIDER, "malformed", `the ${what} response was not the expected shape`);
}

export function hostingerMailClient(
  token: string,
  options: { fetch?: DnsFetch; timeoutMs?: number; baseUrl?: string } = {},
): HostingerMailClient {
  const http = new DnsHttpClient(PROVIDER, { token, ...options });
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  async function get(path: string): Promise<unknown> {
    const response = await http.send<unknown>("GET", `${base}${path}`);
    if (response.status === 404) throw new DnsApiError(PROVIDER, "http", `${path} was not found`, 404);
    return response.body;
  }

  return {
    name: "hostinger",

    async listOrders() {
      const rows: z.infer<typeof OrderEntry>[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const parsed = OrdersPage.safeParse(await get(`/api/mail/v1/orders?page=${page}`));
        if (!parsed.success) throw malformed("orders");
        rows.push(...parsed.data.data);
        const total = parsed.data.meta?.total ?? 0;
        if (parsed.data.data.length === 0 || rows.length >= total) break;
      }
      return rows.map((o) => ({
        id: String(o.id),
        status: o.status ?? "unknown",
        isTrial: o.is_trial ?? false,
        seats: o.seats ?? 0,
        domain: o.domain.name.trim().toLowerCase().replace(/\.$/, ""),
        planTitle: o.plan?.title ?? o.plan?.name ?? "Business Email",
        createdAt: toDate(o.created_at),
        expiresAt: toDate(o.expires_at),
      }));
    },

    async listMailboxes(orderId) {
      const parsed = Mailboxes.safeParse(await get(`/api/mail/v1/orders/${encodeURIComponent(orderId)}/mailboxes`));
      if (!parsed.success) throw malformed("mailboxes");
      const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
      return rows.map((m) => ({
        id: String(m.id),
        address: m.address,
        status: m.status ?? "unknown",
        storageUsedKb: m.usage?.storage_used ?? 0,
        storageQuotaKb: m.usage?.storage_quota ?? 0,
        messagesUsed: m.usage?.messages_used ?? 0,
        messagesQuota: m.usage?.messages_quota ?? 0,
      }));
    },

    async listEmailSubscriptions() {
      const parsed = Subscriptions.safeParse(await get("/api/billing/v1/subscriptions"));
      if (!parsed.success) throw malformed("subscriptions");
      const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
      return rows
        .filter((s) => /business email/i.test(s.name))
        .map((s) => ({
          id: String(s.id),
          name: s.name,
          status: s.status ?? "unknown",
          renewalPrice: s.renewal_price ?? 0,
          currencyCode: s.currency_code ?? "USD",
          billingPeriod: s.billing_period ?? 1,
          billingPeriodUnit: s.billing_period_unit ?? "year",
          autoRenewed: s.is_auto_renewed ?? true,
          expiresAt: toDate(s.expires_at),
          nextBillingAt: toDate(s.next_billing_at),
        }));
    },
  };
}

/** Serves only what it is handed. Empty by default: a mock never invents a mailbox or a price. */
export function mockHostingerMailClient(
  fixtures: {
    orders?: readonly MailOrder[];
    mailboxes?: Readonly<Record<string, readonly MailboxUsage[]>>;
    subscriptions?: readonly EmailSubscription[];
  } = {},
): HostingerMailClient {
  return {
    name: "mock",
    listOrders: async () => [...(fixtures.orders ?? [])],
    listMailboxes: async (orderId) => [...(fixtures.mailboxes?.[orderId] ?? [])],
    listEmailSubscriptions: async () => [...(fixtures.subscriptions ?? [])],
  };
}

/**
 * Real with a token. Without one: the mock only when `ALLOW_MOCK_ADAPTERS=1`,
 * otherwise null — an empty mock would read as "this site has no email",
 * which is a different and wrong answer to "email is not connected".
 */
export function createHostingerMailClientFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): HostingerMailClient | null {
  const token = env["HOSTINGER_API_TOKEN"]?.trim();
  if (token) return hostingerMailClient(token);
  return env["ALLOW_MOCK_ADAPTERS"] === "1" ? mockHostingerMailClient() : null;
}
