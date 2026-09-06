import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, ne } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";
import type { SyncActor } from "./stripe-sync-writes.js";

/**
 * `client_payment_accounts`: every Stripe customer a client pays through.
 * The lookups here are the one place a customer id turns into a client —
 * the sync, the nightly reconcile and the webhook all go through them — and
 * they read the accounts table first, the billing profile's
 * `stripe_customer_id` second, so a profile linked by older code still
 * resolves.
 */

export const STRIPE_PROVIDER = "stripe";

type PaymentAccountRow = typeof schema.clientPaymentAccounts.$inferSelect;

/** The organisation and client a Stripe customer belongs to, whichever table knows it. */
export async function findClientByStripeCustomer(
  db: Db,
  customerId: string,
): Promise<{ organisationId: string; clientId: string } | undefined> {
  const [account] = await db
    .select({ organisationId: schema.clientPaymentAccounts.organisationId, clientId: schema.clientPaymentAccounts.clientId })
    .from(schema.clientPaymentAccounts)
    .where(and(eq(schema.clientPaymentAccounts.provider, STRIPE_PROVIDER), eq(schema.clientPaymentAccounts.externalCustomerId, customerId)))
    .limit(1);
  if (account) return account;
  const [profile] = await db
    .select({ organisationId: schema.billingProfiles.organisationId, clientId: schema.billingProfiles.clientId })
    .from(schema.billingProfiles)
    .where(eq(schema.billingProfiles.stripeCustomerId, customerId))
    .limit(1);
  return profile;
}

/**
 * Whether another organisation already holds this Stripe customer, on a
 * payment account or a billing profile. Both ids are unique across every
 * organisation (the webhook resolves tenancy by them), so a customer claimed
 * elsewhere can neither be linked nor provisioned here.
 */
export async function customerClaimedElsewhere(db: Db, organisationId: string, customerId: string): Promise<boolean> {
  const [account] = await db
    .select({ id: schema.clientPaymentAccounts.id })
    .from(schema.clientPaymentAccounts)
    .where(and(
      eq(schema.clientPaymentAccounts.provider, STRIPE_PROVIDER),
      eq(schema.clientPaymentAccounts.externalCustomerId, customerId),
      ne(schema.clientPaymentAccounts.organisationId, organisationId),
    ))
    .limit(1);
  if (account) return true;
  const [profile] = await db
    .select({ id: schema.billingProfiles.id })
    .from(schema.billingProfiles)
    .where(and(eq(schema.billingProfiles.stripeCustomerId, customerId), ne(schema.billingProfiles.organisationId, organisationId)))
    .limit(1);
  return profile !== undefined;
}

export async function listPaymentAccounts(db: Db, organisationId: string, clientId: string): Promise<PaymentAccountRow[]> {
  return db.select().from(schema.clientPaymentAccounts).where(and(
    eq(schema.clientPaymentAccounts.organisationId, organisationId),
    eq(schema.clientPaymentAccounts.clientId, clientId),
  ));
}

export type AttachPaymentAccountOutcome =
  | { outcome: "created" | "unchanged" | "moved"; account: PaymentAccountRow }
  | { outcome: "claimed_elsewhere"; account: null };

/**
 * Makes sure `customerId` is a payment account of `clientId`. Idempotent: an
 * account already on the client is left alone; one on another client of the
 * same organisation is moved (the owner filed the customer somewhere new);
 * one another organisation holds is refused. The first account a client
 * gets is its primary — unless its billing profile already names a
 * different customer, in which case that one is primary and this is an
 * extra.
 */
export async function attachPaymentAccount(
  db: Db,
  organisationId: string,
  input: { clientId: string; customerId: string; email?: string | undefined; name?: string | undefined } & SyncActor,
): Promise<AttachPaymentAccountOutcome> {
  const { actorKind, actorId } = input;
  const [existing] = await db.select().from(schema.clientPaymentAccounts).where(and(
    eq(schema.clientPaymentAccounts.provider, STRIPE_PROVIDER),
    eq(schema.clientPaymentAccounts.externalCustomerId, input.customerId),
  ));
  if (existing && existing.organisationId !== organisationId) return { outcome: "claimed_elsewhere", account: null };
  if (existing && existing.clientId === input.clientId) return { outcome: "unchanged", account: existing };

  const [others, [profile]] = await Promise.all([
    listPaymentAccounts(db, organisationId, input.clientId),
    db.select({ stripeCustomerId: schema.billingProfiles.stripeCustomerId }).from(schema.billingProfiles).where(and(
      eq(schema.billingProfiles.organisationId, organisationId), eq(schema.billingProfiles.clientId, input.clientId),
    )),
  ]);
  const profileCustomer = profile?.stripeCustomerId ?? null;
  const isPrimary = !others.some((a) => a.isPrimary) && (profileCustomer === null || profileCustomer === input.customerId);

  if (existing) {
    const [moved] = await db.update(schema.clientPaymentAccounts)
      .set({ clientId: input.clientId, isPrimary, updatedAt: new Date() })
      .where(eq(schema.clientPaymentAccounts.id, existing.id)).returning();
    await recordAudit(db, organisationId, {
      actorKind, actorId, action: "payment_account.moved", targetType: "client_payment_account", targetId: existing.id,
      before: existing, after: moved,
    });
    return { outcome: "moved", account: moved! };
  }

  const [created] = await db.insert(schema.clientPaymentAccounts).values({
    organisationId, clientId: input.clientId, provider: STRIPE_PROVIDER, externalCustomerId: input.customerId,
    email: input.email ?? null, name: input.name ?? null, isPrimary,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind, actorId, action: "payment_account.created", targetType: "client_payment_account", targetId: created!.id, after: created,
  });
  return { outcome: "created", account: created! };
}
