import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsCatalogItem, PaymentsSubscriptionDetail } from "@launchos/integrations";
import { and, eq, inArray, isNull, like, ne } from "drizzle-orm";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { supportEmailFor } from "../config.js";
import { ensureEmailIdentity } from "../email/ensure-email-identity.js";
import { slugify, uniqueClientSlug } from "../clients/slug.js";
import { monthlyEquivalentPence, preferredPrice } from "./stripe-sync-match.js";

/**
 * The writing half of the Stripe sync. Every function here is idempotent —
 * a second run with the same Stripe data changes nothing — and every change
 * of a business record is audited. Telemetry-free: the summary is the
 * caller's to assemble from the outcomes returned.
 */

export interface SyncActor {
  actorKind: "user" | "system";
  actorId?: string | undefined;
}

type PackageRow = typeof schema.packages.$inferSelect;
type SubscriptionRow = typeof schema.subscriptions.$inferSelect;

/** The first free package slug: "starter-plan", then "starter-plan-2". */
async function uniquePackageSlug(db: Db, organisationId: string, name: string): Promise<string> {
  const base = slugify(name) || "package";
  const rows = await db
    .select({ slug: schema.packages.slug })
    .from(schema.packages)
    .where(and(eq(schema.packages.organisationId, organisationId), like(schema.packages.slug, `${base}%`)));
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new Error(`could not allocate a package slug for "${name}"`);
}

export interface UpsertLinkedPackageOutcome {
  package: PackageRow;
  /** A package that did not exist before this run. */
  created: boolean;
  /** An existing package whose Stripe link was filled in by this run. */
  linked: boolean;
}

/**
 * One package per selected Stripe product. Matched by product id, then by any
 * of the product's price ids (a package whose Checkout price was set by hand
 * in Settings → Packages). A match keeps its name, price and includes — the
 * owner may have renamed or repriced it locally — and only gains the link.
 * A new package is named after the product and priced from its cheapest
 * monthly price.
 */
export async function upsertLinkedPackage(
  db: Db,
  organisationId: string,
  input: { productId: string; productName: string; prices: readonly PaymentsCatalogItem[] } & SyncActor,
): Promise<UpsertLinkedPackageOutcome> {
  const price = preferredPrice(input.prices);
  if (!price) throw new Error(`stripe sync: product ${input.productId} has no recurring price`);
  const priceIds = input.prices.map((p) => p.priceId);

  const [byProduct] = await db.select().from(schema.packages)
    .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.stripeProductId, input.productId)));
  const [byPrice] = byProduct ? [undefined] : await db.select().from(schema.packages)
    .where(and(eq(schema.packages.organisationId, organisationId), inArray(schema.packages.stripePriceId, priceIds)));
  const existing = byProduct ?? byPrice;

  if (existing) {
    const patch = {
      ...(existing.stripeProductId === input.productId ? {} : { stripeProductId: input.productId }),
      ...(existing.stripePriceId ? {} : { stripePriceId: price.priceId }),
    };
    if (Object.keys(patch).length === 0) return { package: existing, created: false, linked: false };
    const [after] = await db.update(schema.packages).set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.packages.id, existing.id)).returning();
    await recordAudit(db, organisationId, {
      actorKind: input.actorKind, actorId: input.actorId, action: "stripe_sync.package_upserted",
      targetType: "package", targetId: existing.id, before: existing, after,
    });
    return { package: after!, created: false, linked: true };
  }

  const slug = await uniquePackageSlug(db, organisationId, input.productName);
  const [created] = await db.insert(schema.packages).values({
    organisationId, name: input.productName.trim(), slug,
    monthlyPricePence: monthlyEquivalentPence(price), currency: price.currency,
    stripeProductId: input.productId, stripePriceId: price.priceId,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: input.actorKind, actorId: input.actorId, action: "stripe_sync.package_upserted",
    targetType: "package", targetId: created!.id, after: created,
  });
  return { package: created!, created: true, linked: false };
}

/**
 * A client provisioned from a Stripe customer: the row, its billing profile
 * already carrying the customer id, a timeline entry and the audit row.
 *
 * Deliberately not `createClient`: that emits `client.created`, which
 * generates the onboarding task list from the package's templates — wrong
 * for a client who has been paying for two years. The routable support
 * address that event also provides is ensured directly instead.
 */
export async function createImportedClient(
  db: Db,
  organisationId: string,
  input: { name: string; email: string | undefined; customerId: string; packageId: string | null } & SyncActor,
  env: NodeJS.ProcessEnv = process.env,
) {
  const slug = await uniqueClientSlug(db, organisationId, input.name, env);
  const supportEmail = supportEmailFor(slug, env);
  const client = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.clients).values({
      organisationId, name: input.name, slug, supportEmail,
      email: input.email ?? null, packageId: input.packageId, status: "active",
      notes: `Imported from Stripe customer ${input.customerId}.`,
    }).returning();
    await tx.insert(schema.billingProfiles).values({
      organisationId, clientId: row!.id, billingName: input.name, stripeCustomerId: input.customerId,
    });
    await recordActivity(tx, organisationId, {
      clientId: row!.id, actorKind: input.actorKind, actorId: input.actorId, kind: "client.created",
      title: `Client created from Stripe: ${row!.name}`,
      body: `Stripe customer ${input.customerId}. Support address ${supportEmail}.`,
      link: `/clients/${row!.id}`,
    });
    await recordAudit(tx, organisationId, {
      actorKind: input.actorKind, actorId: input.actorId, action: "client.created",
      targetType: "client", targetId: row!.id, after: { ...row, source: "stripe_sync", stripeCustomerId: input.customerId },
    });
    return row!;
  });
  await ensureEmailIdentity(db, organisationId, { clientId: client.id }, env);
  return client;
}

/**
 * Whether another organisation's billing profile already carries this Stripe
 * customer. The customer id is unique across every profile (the webhook
 * resolves tenancy by it), so a customer claimed elsewhere can neither be
 * linked nor provisioned here — the sync skips it rather than failing the run.
 */
export async function customerClaimedElsewhere(db: Db, organisationId: string, customerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.billingProfiles.id })
    .from(schema.billingProfiles)
    .where(and(eq(schema.billingProfiles.stripeCustomerId, customerId), ne(schema.billingProfiles.organisationId, organisationId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Stamps the Stripe customer id on a client matched by email. A profile that
 * already carries a different customer id is left alone (Stripe holds two
 * customers for one email; the first link stands) — the subscription still
 * files under the client. Returns whether anything was written.
 */
export async function linkBillingProfile(
  db: Db,
  organisationId: string,
  input: { clientId: string; customerId: string } & SyncActor,
): Promise<boolean> {
  const where = and(eq(schema.billingProfiles.organisationId, organisationId), eq(schema.billingProfiles.clientId, input.clientId));
  const [before] = await db.select().from(schema.billingProfiles).where(where);
  if (before?.stripeCustomerId) return false;
  if (await customerClaimedElsewhere(db, organisationId, input.customerId)) return false;
  const [after] = before
    ? await db.update(schema.billingProfiles).set({ stripeCustomerId: input.customerId, updatedAt: new Date() }).where(where).returning()
    : await db.insert(schema.billingProfiles).values({ organisationId, clientId: input.clientId, stripeCustomerId: input.customerId }).returning();
  await recordAudit(db, organisationId, {
    actorKind: input.actorKind, actorId: input.actorId, action: "billing_profile.saved",
    targetType: "billing_profile", targetId: after!.id, before, after,
  });
  return true;
}

export interface UpsertSubscriptionOutcome {
  subscription: SubscriptionRow;
  outcome: "created" | "updated" | "unchanged";
  statusChange?: { from: string; to: string };
}

function sameInstant(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

/**
 * The local row for a Stripe subscription, keyed by its Stripe id. An
 * existing row keeps its client — a subscription does not move between
 * clients because a customer's email changed — and takes everything else
 * from Stripe. A status change is reported so the caller can tell the owner.
 */
export async function upsertSubscriptionRow(
  db: Db,
  organisationId: string,
  input: { clientId: string; packageId: string; detail: PaymentsSubscriptionDetail } & SyncActor,
): Promise<UpsertSubscriptionOutcome> {
  const { detail } = input;
  const [before] = await db.select().from(schema.subscriptions).where(and(
    eq(schema.subscriptions.organisationId, organisationId),
    eq(schema.subscriptions.stripeSubscriptionId, detail.id),
  ));
  const values = {
    packageId: input.packageId, status: detail.status, stripePriceId: detail.priceId,
    currentPeriodStart: detail.currentPeriodStart, currentPeriodEnd: detail.currentPeriodEnd,
    amountPence: detail.amountPence, currency: detail.currency,
  };

  if (!before) {
    const [created] = await db.insert(schema.subscriptions)
      .values({ organisationId, clientId: input.clientId, stripeSubscriptionId: detail.id, ...values })
      .returning();
    await recordAudit(db, organisationId, {
      actorKind: input.actorKind, actorId: input.actorId, action: "stripe_sync.subscription_upserted",
      targetType: "subscription", targetId: created!.id, after: created,
    });
    return { subscription: created!, outcome: "created" };
  }

  const unchanged = before.packageId === values.packageId && before.status === values.status
    && before.stripePriceId === values.stripePriceId && before.amountPence === values.amountPence
    && before.currency === values.currency && sameInstant(before.currentPeriodStart, values.currentPeriodStart)
    && sameInstant(before.currentPeriodEnd, values.currentPeriodEnd);
  if (unchanged) return { subscription: before, outcome: "unchanged" };

  const [after] = await db.update(schema.subscriptions).set({ ...values, updatedAt: new Date() })
    .where(eq(schema.subscriptions.id, before.id)).returning();
  await recordAudit(db, organisationId, {
    actorKind: input.actorKind, actorId: input.actorId, action: "stripe_sync.subscription_upserted",
    targetType: "subscription", targetId: before.id, before, after,
  });
  return {
    subscription: after!,
    outcome: "updated",
    ...(before.status === after!.status ? {} : { statusChange: { from: before.status, to: after!.status } }),
  };
}

/** Points the client at the package of its newest live subscription. Returns whether it moved. */
export async function setClientPackage(
  db: Db,
  organisationId: string,
  input: { clientId: string; packageId: string } & SyncActor,
): Promise<boolean> {
  const [before] = await db.select().from(schema.clients).where(and(
    eq(schema.clients.organisationId, organisationId), eq(schema.clients.id, input.clientId), isNull(schema.clients.deletedAt),
  ));
  if (!before || before.packageId === input.packageId) return false;
  const [after] = await db.update(schema.clients).set({ packageId: input.packageId, updatedAt: new Date() })
    .where(eq(schema.clients.id, before.id)).returning();
  await recordAudit(db, organisationId, {
    actorKind: input.actorKind, actorId: input.actorId, action: "stripe_sync.client_package_set",
    targetType: "client", targetId: before.id, before: { packageId: before.packageId }, after: { packageId: after!.packageId },
  });
  return true;
}
