import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsAdapter, PaymentsCatalogItem, PaymentsSubscriptionDetail } from "@launchos/integrations";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { notifyOwner } from "../notifications/notify.js";
import { ClientIndex, isSuggestedProduct, normalisedEmail, proposedClientName } from "./stripe-sync-match.js";
import { getStripeSyncSettings, setStripeSyncSettings, type StripeSyncSummary } from "./stripe-sync-settings.js";
import {
  createImportedClient, customerClaimedElsewhere, linkBillingProfile, setClientPackage, upsertLinkedPackage, upsertSubscriptionRow,
  type SyncActor, type UpsertSubscriptionOutcome,
} from "./stripe-sync-writes.js";

export { businessCase, isSuggestedProduct, proposedClientName } from "./stripe-sync-match.js";

export const STRIPE_SYNC_NOTIFICATION_KIND = "stripe_sync.completed";
export const STRIPE_CLIENT_CREATED_NOTIFICATION_KIND = "stripe_sync.client_created";
export const STRIPE_STATUS_CHANGED_NOTIFICATION_KIND = "stripe_sync.subscription_status";

type PackageRow = typeof schema.packages.$inferSelect;

/** One Stripe product with its prices, as the review screen lists it. */
export interface StripeSyncPreviewProduct {
  productId: string;
  productName: string;
  productActive: boolean;
  prices: PaymentsCatalogItem[];
  matchedPackageId: string | null;
  matchedPackageName: string | null;
  /** Pre-ticked: already linked, or a LaunchFlow-looking name the owner has not previously left out. */
  suggested: boolean;
  ignored: boolean;
}

/** One Stripe subscription with what the import would do with it. */
export interface StripeSyncPreviewSubscription extends PaymentsSubscriptionDetail {
  productName: string | null;
  /** Whether the product is pre-ticked; the owner's ticks on the form are what `applyStripeSync` receives. */
  productSuggested: boolean;
  matchedClientId: string | null;
  matchedClientName: string | null;
  matchedBy: "billing_profile" | "email" | null;
  proposedClientName: string;
  willCreateClient: boolean;
  willImport: boolean;
}

export interface StripeSyncPreview {
  adapter: PaymentsAdapter["name"];
  products: StripeSyncPreviewProduct[];
  subscriptions: StripeSyncPreviewSubscription[];
}

interface CatalogProduct {
  productId: string;
  productName: string;
  productActive: boolean;
  prices: PaymentsCatalogItem[];
}

/** Prices grouped under their product, in catalogue order. */
function groupCatalog(catalog: readonly PaymentsCatalogItem[]): CatalogProduct[] {
  const byProduct = new Map<string, CatalogProduct>();
  for (const price of catalog) {
    const current = byProduct.get(price.productId);
    byProduct.set(price.productId, current
      ? { ...current, prices: [...current.prices, price] }
      : { productId: price.productId, productName: price.productName, productActive: price.productActive, prices: [price] });
  }
  return [...byProduct.values()];
}

/** Packages already carrying a Stripe product or price id, for this organisation. */
async function linkedPackages(db: Db, organisationId: string): Promise<PackageRow[]> {
  return db.select().from(schema.packages).where(and(
    eq(schema.packages.organisationId, organisationId),
    isNull(schema.packages.deletedAt),
    or(isNotNull(schema.packages.stripeProductId), isNotNull(schema.packages.stripePriceId)),
  ));
}

function packageForProduct(packages: readonly PackageRow[], product: CatalogProduct): PackageRow | undefined {
  const priceIds = new Set(product.prices.map((p) => p.priceId));
  return packages.find((pkg) => pkg.stripeProductId === product.productId)
    ?? packages.find((pkg) => pkg.stripePriceId !== null && priceIds.has(pkg.stripePriceId));
}

/**
 * What an import would do, before anything is written: every catalogue
 * product with its suggested tick and any package it already maps to, and
 * every subscription with the client it would file under or create.
 */
export async function previewStripeSync(db: Db, organisationId: string, payments: PaymentsAdapter): Promise<StripeSyncPreview> {
  const [catalog, subscriptions, settings, packages, index] = await Promise.all([
    payments.listCatalog(), payments.listSubscriptions(), getStripeSyncSettings(db, organisationId),
    linkedPackages(db, organisationId), ClientIndex.load(db, organisationId),
  ]);

  const products = groupCatalog(catalog).map((product): StripeSyncPreviewProduct => {
    const matched = packageForProduct(packages, product);
    const ignored = settings.ignoredProductIds.includes(product.productId);
    return {
      ...product,
      matchedPackageId: matched?.id ?? null,
      matchedPackageName: matched?.name ?? null,
      suggested: matched !== undefined || isSuggestedProduct(product.productName, settings.ignoredProductIds, product.productId),
      ignored,
    };
  });
  const productById = new Map(products.map((p) => [p.productId, p]));
  const linkedByProduct = new Map(packages.filter((p) => p.stripeProductId).map((p) => [p.stripeProductId!, p]));

  const previewSubscriptions = subscriptions.map((detail): StripeSyncPreviewSubscription => {
    const product = productById.get(detail.productId);
    const linked = linkedByProduct.get(detail.productId);
    const productSuggested = product?.suggested ?? linked !== undefined;
    const match = index.match(detail);
    const cancelled = detail.status === "cancelled";
    return {
      ...detail,
      productName: product?.productName ?? linked?.name ?? null,
      productSuggested,
      matchedClientId: match?.clientId ?? null,
      matchedClientName: match?.name ?? null,
      matchedBy: match?.matchedBy ?? null,
      proposedClientName: proposedClientName(detail),
      willCreateClient: productSuggested && match === null && !cancelled,
      willImport: productSuggested && (match !== null || !cancelled),
    };
  });

  return { adapter: payments.name, products, subscriptions: previewSubscriptions };
}

export const ApplyStripeSyncInput = z.object({
  selectedProductIds: z.array(z.string().min(1)),
  /** Client names the owner typed on the review screen, by Stripe customer id. */
  clientNames: z.record(z.string(), z.string().trim().min(1).max(200)).default({}),
  actorKind: z.enum(["user", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type ApplyStripeSyncInput = z.input<typeof ApplyStripeSyncInput>;

interface RunContext extends SyncActor {
  db: Db;
  organisationId: string;
  packagesByProduct: ReadonlyMap<string, PackageRow>;
  index: ClientIndex;
  clientNames: Readonly<Record<string, string>>;
  env: NodeJS.ProcessEnv;
}

interface SubscriptionOutcome {
  detail: PaymentsSubscriptionDetail;
  clientId: string;
  clientName: string;
  clientCreated: boolean;
  matchedBy: "billing_profile" | "email" | null;
  row: UpsertSubscriptionOutcome;
}

type SkippedOutcome = { detail: PaymentsSubscriptionDetail; skipped: "no_client" | "unlinked_product" | "claimed_elsewhere" };

/**
 * One subscription through the sync: the client it belongs to (the existing
 * row's, a billing-profile or email match, or a client created for it), the
 * billing-profile link, and the subscription row itself. A cancelled
 * subscription for a customer LaunchOS does not know is skipped — there is
 * no client to hold the history, and the import does not invent one for a
 * relationship that has ended.
 */
async function syncOneSubscription(ctx: RunContext, detail: PaymentsSubscriptionDetail): Promise<SubscriptionOutcome | SkippedOutcome> {
  const pkg = ctx.packagesByProduct.get(detail.productId);
  if (!pkg) return { detail, skipped: "unlinked_product" };
  const { db, organisationId, actorKind, actorId } = ctx;

  const [existing] = await db
    .select({ clientId: schema.subscriptions.clientId, clientName: schema.clients.name })
    .from(schema.subscriptions)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.subscriptions.clientId))
    .where(and(eq(schema.subscriptions.organisationId, organisationId), eq(schema.subscriptions.stripeSubscriptionId, detail.id)));

  let clientId: string;
  let clientName: string;
  let clientCreated = false;
  let matchedBy: SubscriptionOutcome["matchedBy"] = null;
  const email = normalisedEmail(detail.customerEmail);
  if (existing) {
    clientId = existing.clientId;
    clientName = existing.clientName;
    matchedBy = "billing_profile";
    await linkBillingProfile(db, organisationId, { clientId, customerId: detail.customerId, actorKind, actorId });
  } else {
    const match = ctx.index.match(detail);
    if (match) {
      clientId = match.clientId;
      clientName = match.name;
      matchedBy = match.matchedBy;
      if (match.matchedBy === "email") {
        await linkBillingProfile(db, organisationId, { clientId, customerId: detail.customerId, actorKind, actorId });
      }
    } else {
      if (detail.status === "cancelled") return { detail, skipped: "no_client" };
      if (await customerClaimedElsewhere(db, organisationId, detail.customerId)) return { detail, skipped: "claimed_elsewhere" };
      const name = ctx.clientNames[detail.customerId]?.trim() || proposedClientName(detail);
      const client = await createImportedClient(db, organisationId, {
        name, email, customerId: detail.customerId, packageId: pkg.id, actorKind, actorId,
      }, ctx.env);
      clientId = client.id;
      clientName = client.name;
      clientCreated = true;
    }
    ctx.index.register(detail.customerId, email, { clientId, name: clientName });
  }

  const row = await upsertSubscriptionRow(db, organisationId, { clientId, packageId: pkg.id, detail, actorKind, actorId });
  if (row.statusChange) {
    await recordActivity(db, organisationId, {
      clientId, actorKind, actorId, kind: "subscription.status_changed",
      title: `Subscription ${row.statusChange.to.replace("_", " ")} (was ${row.statusChange.from.replace("_", " ")})`,
      body: `Reported by Stripe for ${detail.id}.`,
      link: `/clients/${clientId}/billing`,
    });
  }
  return { detail, clientId, clientName, clientCreated, matchedBy, row };
}

function isSkipped(outcome: SubscriptionOutcome | SkippedOutcome): outcome is SkippedOutcome {
  return "skipped" in outcome;
}

/** Points every touched client at the package of its newest live subscription. */
async function assignClientPackages(ctx: RunContext, outcomes: readonly SubscriptionOutcome[]): Promise<void> {
  const newestLive = new Map<string, SubscriptionOutcome>();
  for (const outcome of outcomes) {
    if (outcome.detail.status === "cancelled") continue;
    const current = newestLive.get(outcome.clientId);
    if (!current || outcome.detail.createdAt > current.detail.createdAt) newestLive.set(outcome.clientId, outcome);
  }
  for (const [clientId, outcome] of newestLive) {
    await setClientPackage(ctx.db, ctx.organisationId, {
      clientId, packageId: outcome.row.subscription.packageId!, actorKind: ctx.actorKind, actorId: ctx.actorId,
    });
  }
}

interface RunInput extends SyncActor {
  trigger: "import" | "reconcile";
  catalog: readonly PaymentsCatalogItem[];
  subscriptions: readonly PaymentsSubscriptionDetail[];
  selectedProductIds: readonly string[];
  clientNames: Readonly<Record<string, string>>;
  env: NodeJS.ProcessEnv;
}

async function runStripeSync(db: Db, organisationId: string, input: RunInput): Promise<StripeSyncSummary> {
  const { actorKind, actorId } = input;
  const products = groupCatalog(input.catalog);
  const selected = new Set(input.selectedProductIds);

  const packageOutcomes = [];
  for (const product of products) {
    if (!selected.has(product.productId)) continue;
    packageOutcomes.push(await upsertLinkedPackage(db, organisationId, { ...product, actorKind, actorId }));
  }
  // Every linked package, whether or not its product still has an active
  // price: a subscription on a retired price still belongs to its package.
  const packagesByProduct = new Map<string, PackageRow>();
  for (const pkg of await linkedPackages(db, organisationId)) {
    if (pkg.stripeProductId && (selected.has(pkg.stripeProductId) || input.trigger === "reconcile")) {
      packagesByProduct.set(pkg.stripeProductId, pkg);
    }
  }

  const ctx: RunContext = {
    db, organisationId, actorKind, actorId, packagesByProduct, env: input.env,
    index: await ClientIndex.load(db, organisationId), clientNames: input.clientNames,
  };
  // Oldest first, so the newest live subscription decides the client's package
  // and a customer's first subscription is the one that names the client.
  const ordered = [...input.subscriptions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const outcomes = [];
  for (const detail of ordered) outcomes.push(await syncOneSubscription(ctx, detail));
  const imported = outcomes.filter((o): o is SubscriptionOutcome => !isSkipped(o));
  await assignClientPackages(ctx, imported);

  const summary: StripeSyncSummary = {
    at: new Date().toISOString(),
    trigger: input.trigger,
    packages: {
      created: packageOutcomes.filter((p) => p.created).map((p) => ({ id: p.package.id, name: p.package.name })),
      linked: packageOutcomes.filter((p) => p.linked).map((p) => ({ id: p.package.id, name: p.package.name })),
    },
    clients: {
      created: imported.filter((o) => o.clientCreated).map((o) => ({ id: o.clientId, name: o.clientName })),
      matched: new Set(imported.filter((o) => !o.clientCreated).map((o) => o.clientId)).size,
    },
    subscriptions: {
      created: imported.filter((o) => o.row.outcome === "created").length,
      updated: imported.filter((o) => o.row.outcome === "updated").length,
      unchanged: imported.filter((o) => o.row.outcome === "unchanged").length,
      skipped: outcomes.filter((o) => isSkipped(o) && o.skipped !== "unlinked_product").length,
    },
    statusChanges: imported.flatMap((o) => (o.row.statusChange
      ? [{ subscriptionId: o.detail.id, clientId: o.clientId, clientName: o.clientName, ...o.row.statusChange }]
      : [])),
  };

  const ignoredProductIds = input.trigger === "import"
    ? products.map((p) => p.productId).filter((id) => !selected.has(id))
    : (await getStripeSyncSettings(db, organisationId)).ignoredProductIds;
  await setStripeSyncSettings(db, organisationId, { ignoredProductIds, lastRunAt: summary.at, lastSummary: summary });
  return summary;
}

function describeSummary(s: StripeSyncSummary): string {
  const parts = [
    `${s.packages.created.length} package${s.packages.created.length === 1 ? "" : "s"} created`,
    `${s.clients.created.length} client${s.clients.created.length === 1 ? "" : "s"} created`,
    `${s.subscriptions.created} subscription${s.subscriptions.created === 1 ? "" : "s"} imported`,
    `${s.subscriptions.updated} updated`,
  ];
  const changes = s.statusChanges.map((c) => `${c.clientName}: ${c.from} → ${c.to}`);
  return `${parts.join(", ")}.${changes.length > 0 ? ` Status changes — ${changes.join("; ")}.` : ""}`;
}

/**
 * The owner's import: packages for the ticked products, a client for every
 * subscription on them that LaunchOS does not yet know, and a subscription
 * row for each. Idempotent — a second run with the same ticks changes
 * nothing and reports every row unchanged. The unticked products are
 * remembered as ignored so the next review leaves them unticked.
 */
export async function applyStripeSync(
  db: Db,
  organisationId: string,
  payments: PaymentsAdapter,
  input: ApplyStripeSyncInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StripeSyncSummary> {
  const v = ApplyStripeSyncInput.parse(input);
  // Both provider round trips before any write: an HTTP call never holds a
  // transaction, and a Stripe outage leaves nothing half-imported.
  const [catalog, subscriptions] = await Promise.all([payments.listCatalog(), payments.listSubscriptions()]);
  const summary = await runStripeSync(db, organisationId, {
    trigger: "import", catalog, subscriptions, selectedProductIds: v.selectedProductIds, clientNames: v.clientNames,
    actorKind: v.actorKind, actorId: v.actorId, env,
  });
  await notifyOwner(db, organisationId, {
    kind: STRIPE_SYNC_NOTIFICATION_KIND,
    title: "Stripe import finished",
    body: describeSummary(summary),
    link: "/settings/billing/stripe/result",
  });
  return summary;
}

/**
 * The nightly (and "Sync now") pass: the stored selection re-applied. Never
 * links a new product — that is the owner's decision on the review screen —
 * but does create a client for a new subscription on a linked package, and
 * rings the owner's bell only when something happened worth knowing: a
 * client created, or a subscription that changed status.
 */
export async function reconcileStripe(
  db: Db,
  organisationId: string,
  payments: PaymentsAdapter,
  options: { actorId?: string | undefined; env?: NodeJS.ProcessEnv } = {},
): Promise<StripeSyncSummary> {
  const [catalog, subscriptions, packages] = await Promise.all([
    payments.listCatalog(), payments.listSubscriptions(), linkedPackages(db, organisationId),
  ]);
  const selectedProductIds = packages.flatMap((p) => (p.stripeProductId ? [p.stripeProductId] : []));
  const summary = await runStripeSync(db, organisationId, {
    trigger: "reconcile", catalog, subscriptions, selectedProductIds, clientNames: {},
    actorKind: options.actorId ? "user" : "system", actorId: options.actorId, env: options.env ?? process.env,
  });
  if (summary.clients.created.length > 0 || summary.statusChanges.length > 0) {
    await notifyOwner(db, organisationId, {
      kind: STRIPE_SYNC_NOTIFICATION_KIND,
      title: summary.clients.created.length > 0
        ? `New client${summary.clients.created.length === 1 ? "" : "s"} from Stripe: ${summary.clients.created.map((c) => c.name).join(", ")}`
        : "Stripe subscription status changed",
      body: describeSummary(summary),
      link: "/settings/billing/stripe/result",
    });
  }
  return summary;
}

export interface ImportedSubscription {
  clientId: string;
  clientName: string;
  clientCreated: boolean;
  outcome: UpsertSubscriptionOutcome["outcome"];
  statusChange?: { from: string; to: string } | undefined;
}

/**
 * One subscription, as the webhook sees it: filed under its client (created
 * if need be) when its product is linked to a package. Null when the product
 * is not linked — the owner has not chosen to import it, and a webhook must
 * not choose for them.
 */
export async function importStripeSubscription(
  db: Db,
  organisationId: string,
  detail: PaymentsSubscriptionDetail,
  actor: SyncActor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ImportedSubscription | null> {
  const packagesByProduct = new Map<string, PackageRow>();
  for (const pkg of await linkedPackages(db, organisationId)) {
    if (pkg.stripeProductId) packagesByProduct.set(pkg.stripeProductId, pkg);
  }
  if (!packagesByProduct.has(detail.productId)) return null;
  const ctx: RunContext = {
    db, organisationId, ...actor, packagesByProduct, env, clientNames: {}, index: await ClientIndex.load(db, organisationId),
  };
  const outcome = await syncOneSubscription(ctx, detail);
  if (isSkipped(outcome)) return null;
  await assignClientPackages(ctx, [outcome]);
  return {
    clientId: outcome.clientId, clientName: outcome.clientName, clientCreated: outcome.clientCreated,
    outcome: outcome.row.outcome, statusChange: outcome.row.statusChange,
  };
}
