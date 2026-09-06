import { MockPaymentsAdapter, type PaymentsCatalogItem, type PaymentsSubscriptionDetail } from "@launchos/integrations";
import { z } from "zod";
import { getPayments } from "@/lib/integrations";
import { getSession } from "@/lib/session";

/**
 * Seeds the mock payments adapter of a *development* web process, so the
 * Stripe review screen can be exercised end to end without Stripe. The mock
 * lives in the server's memory (`getPayments`), which nothing outside the
 * process can reach — hence a route, and hence three locks on it: it does not
 * exist under `NODE_ENV=production`, it wants a signed-in owner, and it
 * refuses when the adapter is anything but the mock. Replaces, never appends;
 * an empty body clears what an earlier run left.
 */

const Catalog = z.object({
  priceId: z.string().min(1),
  productId: z.string().min(1),
  productName: z.string().min(1),
  productActive: z.boolean().default(true),
  amountPence: z.number().int().min(0),
  currency: z.string().min(3).max(3).default("GBP"),
  interval: z.enum(["day", "week", "month", "year"]).default("month"),
  intervalCount: z.number().int().min(1).default(1),
});

const Subscription = z.object({
  id: z.string().min(1),
  status: z.enum(["trialing", "active", "past_due", "cancelled", "paused"]).default("active"),
  providerStatus: z.string().min(1).default("active"),
  customerId: z.string().min(1),
  customerEmail: z.string().email().optional(),
  customerName: z.string().min(1).optional(),
  priceId: z.string().min(1),
  productId: z.string().min(1),
  amountPence: z.number().int().min(0),
  currency: z.string().min(3).max(3).default("GBP"),
  currentPeriodStart: z.coerce.date(),
  currentPeriodEnd: z.coerce.date(),
  cancelAt: z.coerce.date().optional(),
  canceledAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
});

const Body = z.object({
  catalog: z.array(Catalog).default([]),
  subscriptions: z.array(Subscription).default([]),
});

/**
 * Drops the `undefined`s Zod leaves on optional fields, which the adapter's
 * exact optional types refuse. The cast is safe: Zod has just checked every
 * field the target type names.
 */
function compact<T extends object>(value: object): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return Response.json({ error: "Not found" }, { status: 404 });
  const session = await getSession();
  if (!session) return Response.json({ error: "Sign in first" }, { status: 401 });
  if (session.role !== "owner") return Response.json({ error: "Owner only" }, { status: 403 });

  const payments = getPayments();
  if (!(payments instanceof MockPaymentsAdapter)) {
    return Response.json({ error: `The payments adapter is "${payments.name}", not the mock; nothing seeded.` }, { status: 409 });
  }

  const json: unknown = await request.json().catch(() => null);
  const body = Body.safeParse(json ?? {});
  if (!body.success) return Response.json({ error: body.error.issues[0]?.message ?? "Invalid seed" }, { status: 400 });

  const catalog = body.data.catalog.map((item) => compact<PaymentsCatalogItem>(item));
  const subscriptions = body.data.subscriptions.map((item) => compact<PaymentsSubscriptionDetail>(item));
  payments.seedCatalog(catalog);
  payments.seedSubscriptions(subscriptions);
  return Response.json({ ok: true, catalog: catalog.length, subscriptions: subscriptions.length });
}
