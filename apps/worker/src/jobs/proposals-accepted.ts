import {
  PROPOSAL_SIGNED_DOCUMENT_KIND,
  createTask,
  emit,
  getProposalAcceptance,
  getProposalDetail,
  notifyOwner,
  paymentBody,
  queueProposalNotice,
  recordActivity,
  recordAudit,
  renderProposalDocument,
  type ProposalAcceptedJobData,
  type ProposalDetail,
} from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsAdapter } from "@launchos/integrations";
import { and, eq, isNull, sql } from "drizzle-orm";

/**
 * Everything that happens after a client agrees, done where it can be done.
 *
 * `acceptProposal` records the agreement in one transaction and stops. Three
 * things it deliberately left behind land here: the countersigned PDF (which
 * needs Chromium, and only this process has it), the payment step (which is an
 * HTTP call to Stripe), and the work itself (a large write that must not take
 * a client's Accept button down with it).
 *
 * Every step is stamped, so the job is safe to run twice — and it will be,
 * because `proposals-send.ts`'s sweep re-queues anything `acceptProposal`
 * could not hand over.
 */

/** `proposals.metadata` — what this job has already done, so a re-run does not repeat it. */
export const FOLLOW_ON_DONE_AT = "followOnDoneAt";
export const CHECKOUT_SESSION_ID = "checkoutSessionId";
export const CHECKOUT_URL = "checkoutUrl";
export const PROJECT_TASKS_AT = "projectTasksAt";

/** `metadata.launchos` on the Checkout session — what marks it as a proposal's, not a signup's. */
export const PROPOSAL_CHECKOUT_MARKER = "proposal";

/** How many deliverables become tasks. A proposal with forty lines is a project plan, not a task list. */
export const MAX_PROJECT_TASKS = 20;

export const PROPOSAL_PAID_UP_NOTIFICATION_KIND = "proposal.payment_step";

export interface ProposalAcceptedDeps {
  readonly db: Db;
  readonly payments: PaymentsAdapter;
  readonly env: NodeJS.ProcessEnv;
  readonly logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface ProposalAcceptedResult {
  proposalId: string;
  countersigned: boolean;
  payment: PaymentStepKind;
  checkoutUrl: string | null;
  tasksCreated: number;
}

export type PaymentStepKind =
  /** Nothing to pay today — `monthly_on_delivery`. The first month starts when the work goes live. */
  | "none"
  /** One Checkout session: the recurring price, plus the setup fee on the same session when there is one. */
  | "checkout"
  /** Money is due but no Stripe price exists to collect it against; Shoji is told to raise it himself. */
  | "manual"
  /** Already opened on an earlier run. */
  | "already";

export interface PaymentStep {
  kind: Exclude<PaymentStepKind, "already">;
  /** The recurring price to subscribe them to, when there is one. */
  priceId: string | null;
  /** Pence to take on acceptance — the setup fee, or the whole one-off. */
  dueOnAcceptancePence: number;
  recurringMonthlyPence: number;
  /** Why it is manual, for the owner's alert. Null otherwise. */
  reason: string | null;
}

/**
 * Which payment step an accepted proposal opens, decided from the shape and
 * what Stripe actually has — pure, so the three branches are testable without
 * a card or a browser.
 *
 * `setup_plus_monthly` is **one** session carrying both, per the workflow page
 * Shoji agreed: the recurring price subscribes them, the setup fee rides along
 * as a one-off line and Stripe bills it on the first invoice. Two sessions
 * would mean two payments and a client who completed one and abandoned the
 * other.
 *
 * A recurring price is the one thing that cannot be improvised: Stripe needs a
 * Price object to subscribe against, and a proposal quoted off-catalogue has
 * none. That is a `manual` step — Shoji raises the retainer himself — never a
 * silently dropped monthly fee.
 */
export function paymentStepFor(input: {
  dueOnAcceptancePence: number;
  recurringMonthlyPence: number;
  packagePriceId: string | null;
}): PaymentStep {
  const { dueOnAcceptancePence, recurringMonthlyPence, packagePriceId } = input;
  const base = { priceId: null, dueOnAcceptancePence, recurringMonthlyPence, reason: null } as const;

  // Nothing due on acceptance is `monthly_on_delivery`, Shoji's default, and
  // the one shape that opens no Checkout at all. A subscription session here
  // would take the first month the moment they completed it — the opposite of
  // what the proposal said, and what the acceptance email already promised
  // them: "nothing to pay today". The retainer starts when the work goes live.
  if (dueOnAcceptancePence === 0) return { ...base, kind: "none" };

  if (recurringMonthlyPence > 0) {
    if (!packagePriceId) {
      return {
        ...base,
        kind: "manual",
        reason: "The monthly fee is not on a package with a Stripe price, so the setup fee and the retainer both need raising by hand.",
      };
    }
    return { ...base, kind: "checkout", priceId: packagePriceId };
  }
  return { ...base, kind: "checkout" };
}

/**
 * Runs the follow-on for one accepted proposal.
 *
 * Ordered by what a client would miss first: their signed copy, then their
 * payment link, then the work. A step that throws stops the job and pg-boss
 * retries it; every step before it is stamped, so the retry starts where it
 * left off rather than countersigning twice.
 */
export async function handleProposalAccepted(
  deps: ProposalAcceptedDeps,
  job: ProposalAcceptedJobData,
): Promise<ProposalAcceptedResult> {
  const { db, env } = deps;
  const logger = deps.logger ?? console;
  const organisationId = job.organisationId;
  const detail = await getProposalDetail(db, organisationId, job.proposalId);
  if (!detail) throw new Error(`proposal ${job.proposalId} not found in organisation`);
  const acceptance = await getProposalAcceptance(db, organisationId, job.proposalId);
  if (!acceptance) {
    // The acceptance was rolled back, or this is a stale job for a proposal
    // that was never actually agreed. Nothing to follow on from.
    logger.warn({ organisationId, proposalId: job.proposalId }, "proposal follow-on ran with no acceptance recorded; skipping");
    return { proposalId: job.proposalId, countersigned: false, payment: "none", checkoutUrl: null, tasksCreated: 0 };
  }

  const countersigned = await countersign(db, organisationId, { ...detail, acceptance }, env);
  const payment = await openPaymentStep(deps, job, detail, logger);
  const tasksCreated = await writeProjectTasks(db, organisationId, detail, job.clientId, logger);

  await db.update(schema.proposals)
    .set({ metadata: sql`coalesce(${schema.proposals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [FOLLOW_ON_DONE_AT]: new Date().toISOString() })}::jsonb` })
    .where(and(eq(schema.proposals.id, job.proposalId), eq(schema.proposals.organisationId, organisationId)));

  return { proposalId: job.proposalId, countersigned, payment: payment.kind, checkoutUrl: payment.url, tasksCreated };
}

/**
 * The countersigned copy — the same document with the acceptance block and the
 * client's signature on it, filed against `proposal_acceptances.document_id`.
 * That column is the stamp: a second run finds it set and renders nothing.
 */
async function countersign(
  db: Db,
  organisationId: string,
  detail: ProposalDetail & { acceptance: NonNullable<ProposalDetail["acceptance"]> },
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (detail.acceptance.documentId) return false;
  const document = await renderProposalDocument(
    db, organisationId, detail,
    { kind: PROPOSAL_SIGNED_DOCUMENT_KIND, actorKind: "system" },
    undefined, env,
  );
  const [after] = await db.update(schema.proposalAcceptances)
    .set({ documentId: document.id, updatedAt: new Date() })
    .where(and(
      eq(schema.proposalAcceptances.id, detail.acceptance.id),
      eq(schema.proposalAcceptances.organisationId, organisationId),
      isNull(schema.proposalAcceptances.documentId),
    ))
    .returning();
  if (!after) return false;
  await recordAudit(db, organisationId, {
    actorKind: "system", action: "proposal.countersigned",
    targetType: "proposal_acceptance", targetId: detail.acceptance.id, before: detail.acceptance, after,
  });
  return true;
}

interface OpenedPaymentStep {
  kind: PaymentStepKind;
  url: string | null;
}

/**
 * Opens the payment step and tells the client where to pay.
 *
 * `proposals.metadata.checkoutSessionId` is the stamp. Stripe would happily
 * mint a second session, and a client with two links in their inbox is a
 * client who might pay twice.
 */
async function openPaymentStep(
  deps: ProposalAcceptedDeps,
  job: ProposalAcceptedJobData,
  detail: ProposalDetail,
  logger: Pick<Console, "info" | "warn" | "error">,
): Promise<OpenedPaymentStep> {
  const { db, env } = deps;
  const organisationId = job.organisationId;
  const existing = detail.proposal.metadata[CHECKOUT_SESSION_ID];
  if (typeof existing === "string") {
    const url = detail.proposal.metadata[CHECKOUT_URL];
    return { kind: "already", url: typeof url === "string" ? url : null };
  }

  const packagePriceId = await stripePriceForPackage(db, organisationId, job.packageId);
  const step = paymentStepFor({
    dueOnAcceptancePence: job.dueOnAcceptancePence,
    recurringMonthlyPence: job.recurringMonthlyPence,
    packagePriceId,
  });

  if (step.kind === "none") {
    await notifyOwner(db, organisationId, {
      kind: PROPOSAL_PAID_UP_NOTIFICATION_KIND,
      title: `${detail.proposal.reference} accepted — nothing to collect today`,
      body: `The ${detail.totals.recurringMonthlyPence > 0 ? "monthly fee starts" : "money is due"} when the work goes live; raise the first invoice then.`,
      link: `/proposals/${detail.proposal.id}`,
    });
    return { kind: "none", url: null };
  }
  if (step.kind === "manual") {
    await notifyOwner(db, organisationId, {
      kind: PROPOSAL_PAID_UP_NOTIFICATION_KIND,
      title: `${detail.proposal.reference} accepted — the payment needs setting up by hand`,
      body: step.reason ?? "No Stripe price to collect against.",
      link: `/proposals/${detail.proposal.id}`,
    });
    return { kind: "manual", url: null };
  }

  const recipient = detail.recipient;
  if (!recipient) {
    logger.warn({ organisationId, proposalId: detail.proposal.id }, "accepted proposal has no email address to send a payment link to");
    return { kind: "manual", url: null };
  }

  const base = env.APP_URL ?? "http://localhost:3000";
  const session = await deps.payments.createCheckoutSession({
    ...(step.priceId ? { priceId: step.priceId } : {}),
    ...(step.dueOnAcceptancePence > 0
      ? {
        oneOff: {
          amountPence: step.dueOnAcceptancePence,
          currency: detail.proposal.pricing.currency,
          description: step.priceId
            ? `${detail.proposal.title} — setup fee (${detail.proposal.reference})`
            : `${detail.proposal.title} (${detail.proposal.reference})`,
        },
      }
      : {}),
    customerEmail: recipient.email.toLowerCase(),
    successUrl: `${base}/p/${detail.proposal.publicToken}?paid=1`,
    cancelUrl: `${base}/p/${detail.proposal.publicToken}`,
    clientReference: detail.proposal.reference,
    metadata: {
      launchos: PROPOSAL_CHECKOUT_MARKER,
      organisationId,
      proposalId: detail.proposal.id,
      acceptanceId: job.acceptanceId,
      ...(job.clientId ? { clientId: job.clientId } : {}),
      ...(job.packageId ? { packageId: job.packageId } : {}),
    },
  });
  if (!session.url) throw new Error(`payments: checkout session ${session.id} has no url`);

  const notice = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.proposals)
      .set({
        metadata: sql`coalesce(${schema.proposals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [CHECKOUT_SESSION_ID]: session.id, [CHECKOUT_URL]: session.url })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.proposals.id, detail.proposal.id),
        eq(schema.proposals.organisationId, organisationId),
        sql`${schema.proposals.metadata}->>${CHECKOUT_SESSION_ID} is null`,
      ))
      .returning();
    // Lost the stamp to a concurrent run: their session is the one the client
    // was told about, so this one is abandoned rather than emailed as a second.
    if (!after) return null;
    await recordAudit(tx, organisationId, {
      actorKind: "system", action: "proposal.payment_opened",
      targetType: "proposal", targetId: detail.proposal.id,
      after: { sessionId: session.id, dueOnAcceptancePence: step.dueOnAcceptancePence, recurringMonthlyPence: step.recurringMonthlyPence, provider: deps.payments.name },
    });
    return queueProposalNotice(tx, organisationId, {
      proposal: after,
      notice: "payment",
      to: recipient.email,
      subject: `Payment link for ${detail.proposal.reference}`,
      body: paymentBody(after, detail.totals, recipient.name, session.url!),
      actorKind: "system",
    });
  });
  if (notice) await emit({ name: "message.queued", organisationId, messageId: notice.id });
  return { kind: notice ? "checkout" : "already", url: session.url };
}

/** The package's Stripe price, or null — the only thing a subscription can be opened against. */
async function stripePriceForPackage(db: Db, organisationId: string, packageId: string | null): Promise<string | null> {
  if (!packageId) return null;
  const [pkg] = await db.select({ stripePriceId: schema.packages.stripePriceId }).from(schema.packages)
    .where(and(eq(schema.packages.id, packageId), eq(schema.packages.organisationId, organisationId)));
  return pkg?.stripePriceId ?? null;
}

/**
 * The work, as tasks — a stand-in for the project P4 will create.
 *
 * Until phases and milestones exist, the deliverables the client agreed to are
 * the only record of what was promised, and leaving them on a PDF nobody works
 * from is how a signed proposal quietly turns into a forgotten one. One
 * onboarding task per deliverable, client-visible so it shows in their portal,
 * with the proposal's reference in the description so P4 can find them again.
 */
async function writeProjectTasks(
  db: Db,
  organisationId: string,
  detail: ProposalDetail,
  clientId: string | null,
  logger: Pick<Console, "info" | "warn" | "error">,
): Promise<number> {
  if (!clientId) return 0;
  if (detail.proposal.metadata[PROJECT_TASKS_AT]) return 0;
  const deliverables = detail.proposal.scope.deliverables.slice(0, MAX_PROJECT_TASKS);
  if (deliverables.length === 0) return 0;

  // The stamp is taken first and conditionally, so two runs racing cannot both
  // write the list. Losing the race means the other run is writing them.
  const [claimed] = await db.update(schema.proposals)
    .set({ metadata: sql`coalesce(${schema.proposals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [PROJECT_TASKS_AT]: new Date().toISOString() })}::jsonb` })
    .where(and(
      eq(schema.proposals.id, detail.proposal.id),
      eq(schema.proposals.organisationId, organisationId),
      sql`${schema.proposals.metadata}->>${PROJECT_TASKS_AT} is null`,
    ))
    .returning();
  if (!claimed) return 0;

  let created = 0;
  for (const deliverable of deliverables) {
    try {
      await createTask(db, organisationId, {
        clientId,
        title: deliverable,
        kind: "build",
        phase: "onboarding",
        descriptionMd: `From accepted proposal ${detail.proposal.reference} — ${detail.proposal.title}.`,
        clientVisible: true,
        actorKind: "system",
      });
      created += 1;
    } catch (error) {
      // One bad deliverable must not cost the other nineteen. The proposal is
      // the record either way; this is a convenience.
      logger.error({ organisationId, proposalId: detail.proposal.id, deliverable, err: error }, "could not create a task from a deliverable");
    }
  }
  await recordActivity(db, organisationId, {
    clientId, actorKind: "system", kind: "proposal.work_started",
    title: `${created} task${created === 1 ? "" : "s"} opened from proposal ${detail.proposal.reference}`,
    link: `/clients/${clientId}/tasks`,
  });
  return created;
}
