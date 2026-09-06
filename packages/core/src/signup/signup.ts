import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { createEmailAdapter, renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import { addMonths, type PaymentsAdapter, type PaymentsCheckoutSession, type PaymentsWebhookEvent } from "@launchos/integrations";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { createInvoiceFromSubscription, markInvoiceSent } from "../billing/invoices.js";
import { createSubscription } from "../billing/subscriptions.js";
import { createClientUser } from "../client-users/create-client-user.js";
import { createClient } from "../clients/create-client.js";
import { appUrl, brandEmailContext, supportEmailFor } from "../config.js";
import { createLead, type LeadRow } from "../leads/leads.js";
import { notifyOwner } from "../notifications/notify.js";

/** `metadata.launchos` on the Checkout session and its webhook — what marks it as ours. */
export const SIGNUP_MARKER = "signup";
export const SIGNUP_LEAD_SOURCE = "signup";
export const SIGNUP_COMPLETED_NOTIFICATION_KIND = "signup.completed";
/** A claim older than this is considered abandoned (the winner crashed) and may be retaken. */
export const SIGNUP_CLAIM_TTL_MS = 5 * 60_000;

export class SignupRefused extends Error {
  constructor(readonly reason: "unknown_package" | "not_paid" | "not_a_signup" | "wrong_organisation", message: string) {
    super(message);
    this.name = "SignupRefused";
  }
}

export interface SignupDeps {
  payments: PaymentsAdapter;
  /** Sends the welcome email. Defaults to `createEmailAdapter(env)` — mock unless `EMAIL_ADAPTER=smtp`. */
  email?: EmailAdapter | undefined;
}

const Person = {
  email: z.string().trim().email().max(320),
  name: z.string().trim().min(1).max(120),
  business: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).optional(),
};

export const CreateSignupSessionInput = z.object({ packageSlug: z.string().trim().min(1).max(60), ...Person });
export type CreateSignupSessionInput = z.input<typeof CreateSignupSessionInput>;

export type SignupSessionResult =
  | { mode: "checkout"; url: string; sessionId: string; leadId: string }
  | { mode: "invoice"; clientId: string; subscriptionId: string; invoiceId: string | null; portalUserId: string | null; leadId: string; url: string };

/** The Checkout metadata `completeSignup` reads back. Everything a string: Stripe metadata is. */
const SignupMetadata = z.object({
  launchos: z.literal(SIGNUP_MARKER),
  organisationId: z.string().uuid(),
  packageId: z.string().uuid(),
  leadId: z.string().uuid().optional(),
  email: z.string().email(),
  name: z.string().min(1),
  business: z.string().min(1),
  phone: z.string().optional(),
});

async function activePackageBySlug(db: Db, organisationId: string, slug: string) {
  const [pkg] = await db.select().from(schema.packages)
    .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.slug, slug), eq(schema.packages.active, true), isNull(schema.packages.deletedAt)));
  return pkg ?? null;
}

/**
 * Starts a self-serve signup. With a `stripe_price_id` on the package this is
 * a hosted Checkout session in subscription mode; the buyer pays, Stripe
 * calls back and `completeSignup` provisions the client. Without one the
 * package cannot be bought online, so the client, the subscription and the
 * first invoice are made straight away and the welcome email carries the
 * invoice link — the "one-off invoice" flow.
 *
 * Either way a `leads` row is written first (source `signup`), so a buyer who
 * abandons Checkout is still a lead on the Leads page, and the Checkout
 * session id on it is what `completeSignup` keys on.
 */
export async function createSignupSession(
  db: Db,
  organisationId: string,
  input: CreateSignupSessionInput,
  deps: SignupDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SignupSessionResult> {
  const v = CreateSignupSessionInput.parse(input);
  const pkg = await activePackageBySlug(db, organisationId, v.packageSlug);
  if (!pkg) throw new SignupRefused("unknown_package", "That package is not available.");

  const lead = await createLead(db, organisationId, {
    name: v.name, email: v.email, business: v.business, ...(v.phone ? { phone: v.phone } : {}),
    source: SIGNUP_LEAD_SOURCE, metadata: { packageId: pkg.id, packageSlug: pkg.slug }, notifyOwner: false, actorKind: "client",
  });

  if (!pkg.stripePriceId) {
    const provisioned = await provisionSignup(db, organisationId, {
      lead, packageId: pkg.id, email: v.email, name: v.name, business: v.business, ...(v.phone ? { phone: v.phone } : {}), stripe: null,
    }, deps, env);
    return { mode: "invoice", ...provisioned, url: `${appUrl(env)}/signup/done?client=${provisioned.clientId}` };
  }

  const base = appUrl(env);
  const metadata: z.infer<typeof SignupMetadata> = {
    launchos: SIGNUP_MARKER, organisationId, packageId: pkg.id, leadId: lead.id,
    email: v.email.toLowerCase(), name: v.name, business: v.business, ...(v.phone ? { phone: v.phone } : {}),
  };
  const session = await deps.payments.createCheckoutSession({
    priceId: pkg.stripePriceId,
    customerEmail: v.email.toLowerCase(),
    successUrl: `${base}/signup/done?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/signup?package=${encodeURIComponent(pkg.slug)}`,
    clientReference: lead.id,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) as Record<string, string>,
  });
  if (!session.url) throw new Error("payments: checkout session has no url");

  await db.update(schema.leads)
    .set({ metadata: sql`coalesce(${schema.leads.metadata}, '{}'::jsonb) || ${JSON.stringify({ checkoutSessionId: session.id })}::jsonb`, updatedAt: new Date() })
    .where(and(eq(schema.leads.id, lead.id), eq(schema.leads.organisationId, organisationId)));
  await recordAudit(db, organisationId, {
    actorKind: "client", action: "signup.checkout_started", targetType: "lead", targetId: lead.id,
    after: { sessionId: session.id, packageId: pkg.id, provider: deps.payments.name },
  });
  return { mode: "checkout", url: session.url, sessionId: session.id, leadId: lead.id };
}

export const CompleteSignupInput = z.object({
  session: z.object({
    id: z.string().min(1),
    status: z.enum(["open", "complete", "expired"]),
    paymentStatus: z.enum(["paid", "unpaid", "no_payment_required"]),
    customerId: z.string().optional(),
    subscriptionId: z.string().optional(),
    customerEmail: z.string().optional(),
    metadata: z.record(z.string(), z.string()),
  }),
});
export type CompleteSignupInput = { session: PaymentsCheckoutSession };

export interface CompleteSignupResult {
  clientId: string | null;
  subscriptionId: string | null;
  portalUserId: string | null;
  leadId: string;
  /** True when this session had already been (or is being) provisioned; nothing was touched. */
  alreadyCompleted: boolean;
}

/**
 * Provisions the client once Checkout has been paid — from the
 * `checkout.session.completed` webhook (`syncFromPaymentsEvent`) and, for an
 * instant answer, from the `/signup/done` page after `retrieveCheckoutSession`.
 * Idempotent by session: the lead row is the claim (one conditional UPDATE),
 * so the two callers cannot make two clients, and a session already
 * provisioned answers `alreadyCompleted` with the client id.
 *
 * Only a session carrying our `metadata.launchos = "signup"` marker for this
 * organisation is accepted, and only once Stripe says it is complete and paid.
 */
export async function completeSignup(
  db: Db,
  organisationId: string,
  input: CompleteSignupInput,
  deps: Pick<SignupDeps, "email"> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CompleteSignupResult> {
  const session = CompleteSignupInput.parse(input).session as PaymentsCheckoutSession;
  const meta = SignupMetadata.safeParse(session.metadata);
  if (!meta.success) throw new SignupRefused("not_a_signup", "This Checkout session is not a LaunchOS signup.");
  if (meta.data.organisationId !== organisationId) throw new SignupRefused("wrong_organisation", "This signup belongs to another organisation.");
  if (session.status !== "complete" || session.paymentStatus === "unpaid") {
    throw new SignupRefused("not_paid", "Payment has not completed yet.");
  }

  const lead = await leadForSession(db, organisationId, session, meta.data);
  if (lead.clientId) {
    const [subscription] = await db.select({ id: schema.subscriptions.id }).from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.organisationId, organisationId), eq(schema.subscriptions.clientId, lead.clientId)));
    return { clientId: lead.clientId, subscriptionId: subscription?.id ?? null, portalUserId: null, leadId: lead.id, alreadyCompleted: true };
  }

  // The claim: one caller provisions; a stale claim (the winner crashed) is retaken after the TTL.
  const now = new Date();
  const stale = new Date(now.getTime() - SIGNUP_CLAIM_TTL_MS).toISOString();
  const [claimed] = await db.update(schema.leads)
    .set({ metadata: sql`coalesce(${schema.leads.metadata}, '{}'::jsonb) || ${JSON.stringify({ signupClaimedAt: now.toISOString(), checkoutSessionId: session.id })}::jsonb`, updatedAt: now })
    .where(and(
      eq(schema.leads.id, lead.id),
      eq(schema.leads.organisationId, organisationId),
      isNull(schema.leads.clientId),
      sql`(${schema.leads.metadata}->>'signupClaimedAt') IS NULL OR (${schema.leads.metadata}->>'signupClaimedAt') < ${stale}`,
    ))
    .returning();
  if (!claimed) return { clientId: null, subscriptionId: null, portalUserId: null, leadId: lead.id, alreadyCompleted: true };

  const provisioned = await provisionSignup(db, organisationId, {
    lead: claimed, packageId: meta.data.packageId, email: meta.data.email, name: meta.data.name, business: meta.data.business,
    ...(meta.data.phone ? { phone: meta.data.phone } : {}),
    stripe: { customerId: session.customerId ?? null, subscriptionId: session.subscriptionId ?? null, sessionId: session.id },
  }, deps, env);
  return { ...provisioned, alreadyCompleted: false };
}

async function leadForSession(db: Db, organisationId: string, session: PaymentsCheckoutSession, meta: z.infer<typeof SignupMetadata>): Promise<LeadRow> {
  const byId = meta.leadId
    ? (await db.select().from(schema.leads).where(and(eq(schema.leads.id, meta.leadId), eq(schema.leads.organisationId, organisationId))))[0]
    : undefined;
  if (byId) return byId;
  const [bySession] = await db.select().from(schema.leads)
    .where(and(eq(schema.leads.organisationId, organisationId), sql`${schema.leads.metadata}->>'checkoutSessionId' = ${session.id}`));
  if (bySession) return bySession;
  // A session we never saw start (the lead row was lost, or Checkout was
  // opened by hand in the Stripe dashboard with our metadata): make the lead now.
  return createLead(db, organisationId, {
    name: meta.name, email: meta.email, business: meta.business, ...(meta.phone ? { phone: meta.phone } : {}),
    source: SIGNUP_LEAD_SOURCE, metadata: { packageId: meta.packageId, checkoutSessionId: session.id }, notifyOwner: false, actorKind: "client",
  });
}

interface ProvisionInput {
  lead: LeadRow;
  packageId: string;
  email: string;
  name: string;
  business: string;
  phone?: string;
  /** Null for the invoice flow; the Checkout ids otherwise. */
  stripe: { customerId: string | null; subscriptionId: string | null; sessionId: string } | null;
}

interface Provisioned {
  clientId: string;
  subscriptionId: string;
  invoiceId: string | null;
  portalUserId: string | null;
  leadId: string;
}

/**
 * The client, its subscription (and first invoice in the invoice flow), a
 * portal login, the lead marked converted, the welcome email, and the
 * owner's bell — the whole of "a new client exists".
 */
async function provisionSignup(
  db: Db,
  organisationId: string,
  input: ProvisionInput,
  deps: Pick<SignupDeps, "email"> & Partial<Pick<SignupDeps, "payments">>,
  env: NodeJS.ProcessEnv,
): Promise<Provisioned> {
  const [pkg] = await db.select().from(schema.packages).where(and(eq(schema.packages.id, input.packageId), eq(schema.packages.organisationId, organisationId)));
  if (!pkg) throw new SignupRefused("unknown_package", "That package is not available.");
  const now = new Date();

  const client = await createClient(db, organisationId, {
    name: input.business, email: input.email.toLowerCase(), ...(input.phone ? { phone: input.phone } : {}), packageId: pkg.id,
    notes: `Self-serve signup by ${input.name} (${input.email}).`, actorKind: "client",
  });

  let subscriptionId: string;
  let invoiceId: string | null = null;
  if (input.stripe) {
    const [subscription] = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      if (input.stripe!.customerId) {
        await tx.update(schema.billingProfiles).set({ stripeCustomerId: input.stripe!.customerId, updatedAt: now })
          .where(and(eq(schema.billingProfiles.organisationId, organisationId), eq(schema.billingProfiles.clientId, client.id)));
      }
      const rows = await tx.insert(schema.subscriptions).values({
        organisationId, clientId: client.id, packageId: pkg.id, stripeSubscriptionId: input.stripe!.subscriptionId, status: "active",
        currentPeriodStart: now, currentPeriodEnd: addMonths(now, 1), amountPence: pkg.monthlyPricePence, currency: pkg.currency,
        metadata: { checkoutSessionId: input.stripe!.sessionId },
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: "client", action: "subscription.created", targetType: "subscription", targetId: rows[0]!.id, after: rows[0],
      });
      return rows;
    });
    subscriptionId = subscription!.id;
  } else {
    if (!deps.payments) throw new Error("signup: the invoice flow needs a payments adapter");
    const { subscription } = await createSubscription(db, organisationId, { clientId: client.id, packageId: pkg.id, actorKind: "client" }, deps.payments);
    subscriptionId = subscription.id;
    const invoice = await createInvoiceFromSubscription(db, organisationId, { subscriptionId, actorKind: "system" });
    await markInvoiceSent(db, organisationId, { invoiceId: invoice.id, actorKind: "system" });
    invoiceId = invoice.id;
  }

  let portalUserId: string | null = null;
  let oneTimePassword: string | null = null;
  let portalProblem: string | null = null;
  try {
    const portal = await createClientUser(db, organisationId, { clientId: client.id, email: input.email, name: input.name, role: "client_admin" });
    portalUserId = portal.user.id;
    oneTimePassword = portal.oneTimePassword;
  } catch (error) {
    portalProblem = error instanceof Error ? error.message : String(error);
  }

  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const stamp = { signupCompletedAt: now.toISOString(), ...(input.stripe ? { checkoutSessionId: input.stripe.sessionId } : { invoiceId }) };
    const [after] = await tx.update(schema.leads)
      .set({ status: "converted", clientId: client.id, metadata: sql`coalesce(${schema.leads.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`, updatedAt: now })
      .where(and(eq(schema.leads.id, input.lead.id), eq(schema.leads.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: "client", action: "signup.completed", targetType: "client", targetId: client.id,
      after: { leadId: input.lead.id, subscriptionId, invoiceId, portalUserId, mode: input.stripe ? "checkout" : "invoice" },
    });
    await recordAudit(tx, organisationId, { actorKind: "client", action: "lead.converted", targetType: "lead", targetId: input.lead.id, before: input.lead, after });
    await recordActivity(tx, organisationId, {
      clientId: client.id, actorKind: "client", kind: "signup.completed",
      title: `Signed up online for ${pkg.name}`, body: input.stripe ? "Paid through Stripe Checkout." : "First invoice raised and emailed.",
      link: `/clients/${client.id}/billing`,
    });
  });

  const welcome = await sendWelcomeEmail(deps.email ?? createEmailAdapter(env), env, {
    to: input.email.toLowerCase(), name: input.name, packageName: pkg.name, oneTimePassword, invoiceId,
  }).then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));

  const problems = [portalProblem ? `Portal login not created: ${portalProblem}.` : null, welcome ? `Welcome email failed: ${welcome}.` : null].filter(Boolean);
  await notifyOwner(db, organisationId, {
    kind: SIGNUP_COMPLETED_NOTIFICATION_KIND,
    title: `New client signed up: ${client.name} (${pkg.name})`,
    body: problems.length > 0 ? problems.join(" ") : `${input.name} paid online${invoiceId ? "" : " through Stripe Checkout"}; onboarding tasks are being generated.`,
    link: `/clients/${client.id}`,
  });
  return { clientId: client.id, subscriptionId, invoiceId, portalUserId, leadId: input.lead.id };
}

interface WelcomeInput {
  to: string;
  name: string;
  packageName: string;
  oneTimePassword: string | null;
  invoiceId: string | null;
}

/**
 * Sent straight through the adapter — never as a stored `messages` row —
 * because it carries the temporary password, which must not sit in a table
 * every admin can read. Same reasoning as the staff invite, which shows the
 * password once and never stores it.
 */
async function sendWelcomeEmail(email: EmailAdapter, env: NodeJS.ProcessEnv, input: WelcomeInput): Promise<void> {
  const brand = brandEmailContext(env);
  const paragraphs = [
    `Hello ${input.name},`,
    `Welcome to LaunchFlow — your ${input.packageName} plan is set up and we are already lining up your onboarding.`,
    ...(input.oneTimePassword
      ? [`Your portal login is ${input.to} with the temporary password ${input.oneTimePassword}. Sign in and change it from your account page.`]
      : [`We will send your portal login separately.`]),
    ...(input.invoiceId
      ? [`Your first invoice is ready in the portal — you can view, pay and download it from there.`]
      : [`Your first payment has gone through; your invoices will appear in the portal as they are raised.`]),
  ];
  const { text, html } = renderBrandedEmail({
    preheader: "Your plan is set up. Here is how to get into your portal.",
    heading: "Welcome to LaunchFlow",
    paragraphs,
    cta: { label: input.invoiceId ? "Open your portal and invoice" : "Open your portal", url: `${brand.appUrl}${input.invoiceId ? `/portal/invoices/${input.invoiceId}` : "/portal"}` },
    logoUrl: brand.logoUrl, appUrl: brand.appUrl, supportEmail: brand.supportEmail,
  });
  await email.send({ to: input.to, from: env.MAIL_FROM ?? supportEmailFor("hello", env), subject: "Welcome to LaunchFlow — your portal login", text, html });
}

/**
 * For the Stripe webhook route: a `checkout.session.completed` for a brand
 * new customer has no `billing_profiles` row to resolve tenancy from, so the
 * organisation comes from our own metadata on the session instead. Null for
 * anything that is not a LaunchOS signup.
 */
export function signupOrganisationFromEvent(event: PaymentsWebhookEvent): string | null {
  if (event.type !== "checkout.session.completed") return null;
  const object = (event.data as { object?: { metadata?: unknown } }).object;
  const meta = z.object({ launchos: z.literal(SIGNUP_MARKER), organisationId: z.string().uuid() }).safeParse(object?.metadata);
  return meta.success ? meta.data.organisationId : null;
}
