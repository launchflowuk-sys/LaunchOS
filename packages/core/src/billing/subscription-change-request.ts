import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";
import { activeSubscriptionForClient } from "./subscriptions.js";

/** `payload.action` on a plan change request — the key the pending index tests. */
export const SUBSCRIPTION_CHANGE_ACTION = "subscription_change";

/** The partial unique index in `packages/db/src/schema/agents.ts` that keeps requests to one per client. */
export const PENDING_SUBSCRIPTION_CHANGE_INDEX = "approvals_pending_subscription_change";

export const SUBSCRIPTION_CHANGE_KINDS = ["cancel", "downgrade", "upgrade", "other"] as const;
export type SubscriptionChangeKind = (typeof SUBSCRIPTION_CHANGE_KINDS)[number];

/** The request in the client's words — the portal's select and the admin card share it. */
export const SUBSCRIPTION_CHANGE_LABEL: Record<SubscriptionChangeKind, string> = {
  cancel: "Cancel my plan",
  downgrade: "Move to a smaller plan",
  upgrade: "Move to a bigger plan",
  other: "Something else",
};

/** The same request as a verb phrase, for the sentence on the approval card. */
const SUBSCRIPTION_CHANGE_VERB: Record<SubscriptionChangeKind, string> = {
  cancel: "cancel",
  downgrade: "move to a smaller plan than",
  upgrade: "move to a bigger plan than",
  other: "change",
};

export const RequestSubscriptionChangeInput = z.object({
  clientId: z.string().uuid(),
  /** The Better Auth user id of the portal user asking. */
  actorUserId: z.string().min(1),
  kind: z.enum(SUBSCRIPTION_CHANGE_KINDS),
  message: z.string().trim().min(1).max(4000),
});
export type RequestSubscriptionChangeInput = z.input<typeof RequestSubscriptionChangeInput>;

/**
 * What the approval row carries. Written from our own rows at request time —
 * the client's name and the package's price are what the owner reads on the
 * card, and `summary` is the one sentence that says what approving means.
 */
export const SubscriptionChangePayload = z.object({
  action: z.literal(SUBSCRIPTION_CHANGE_ACTION),
  clientId: z.string().uuid(),
  clientName: z.string(),
  subscriptionId: z.string().uuid(),
  packageId: z.string().uuid().nullable(),
  packageName: z.string(),
  monthlyPricePence: z.number().int(),
  currency: z.string(),
  kind: z.enum(SUBSCRIPTION_CHANGE_KINDS),
  message: z.string(),
  summary: z.string(),
  requestedByUserId: z.string(),
});
export type SubscriptionChangePayload = z.infer<typeof SubscriptionChangePayload>;

export type ApprovalRow = typeof schema.approvals.$inferSelect;

export class SubscriptionChangeRefused extends Error {
  constructor(
    readonly reason: "no_active_subscription" | "already_pending",
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionChangeRefused";
  }
}

/** `£149` for a round amount, `£149.50` otherwise — the way a price is said aloud. */
function priceInWords(pence: number, currency: string): string {
  const symbol = currency.toUpperCase() === "GBP" ? "£" : `${currency.toUpperCase()} `;
  const whole = pence % 100 === 0;
  return `${symbol}${whole ? String(pence / 100) : (pence / 100).toFixed(2)}`;
}

function summaryFor(
  clientName: string,
  kind: SubscriptionChangeKind,
  packageName: string,
  pricePence: number,
  currency: string,
  message: string,
): string {
  const plan = `the ${packageName} package (${priceInWords(pricePence, currency)}/month)`;
  return `${clientName} asks to ${SUBSCRIPTION_CHANGE_VERB[kind]} ${plan}, reason: ${message}`;
}

/** True when `error` is the pending index refusing a second request for the same client. */
export function isPendingSubscriptionChangeCollision(error: unknown): boolean {
  for (let node: unknown = error, depth = 0; node !== null && node !== undefined && depth < 5; depth += 1) {
    if (typeof node !== "object") return false;
    const candidate = node as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (
      candidate.code === "23505" &&
      (candidate.constraint_name === PENDING_SUBSCRIPTION_CHANGE_INDEX || candidate.constraint === PENDING_SUBSCRIPTION_CHANGE_INDEX)
    ) {
      return true;
    }
    node = candidate.cause;
  }
  return false;
}

/** The request still waiting for a decision on this client, if any. Tenancy-scoped. */
export async function findPendingSubscriptionChange(
  db: Db,
  organisationId: string,
  clientId: string,
): Promise<ApprovalRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.organisationId, organisationId),
      eq(schema.approvals.status, "pending"),
      isNull(schema.approvals.deletedAt),
      sql`${schema.approvals.payload}->>'action' = ${SUBSCRIPTION_CHANGE_ACTION}`,
      sql`${schema.approvals.payload}->>'clientId' = ${clientId}`,
    ))
    .orderBy(desc(schema.approvals.createdAt))
    .limit(1);
  return row;
}

/**
 * The newest request this client has made, decided or not — what the portal
 * shows under "Need to change something?" so a client sees the answer to the
 * question they asked last.
 */
export async function latestSubscriptionChange(
  db: Db,
  organisationId: string,
  clientId: string,
): Promise<ApprovalRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.organisationId, organisationId),
      isNull(schema.approvals.deletedAt),
      sql`${schema.approvals.payload}->>'action' = ${SUBSCRIPTION_CHANGE_ACTION}`,
      sql`${schema.approvals.payload}->>'clientId' = ${clientId}`,
    ))
    .orderBy(desc(schema.approvals.createdAt))
    .limit(1);
  return row;
}

/**
 * A client asking, from the portal, to cancel, shrink, grow or otherwise
 * change their plan.
 *
 * Nothing changes here. The request is parked in `approvals` as a
 * `subscription_change` with no run behind it — exactly where an agent's
 * outward action or an invoice send waits — and a human decides it in the
 * admin portal; `applySubscriptionChangeDecision` then carries the decision
 * out and tells the client. The summary on the card is written from our own
 * rows, so what the owner reads is the client's name and the package's price,
 * with the client's words quoted after "reason:".
 *
 * Refused, with a `SubscriptionChangeRefused` the caller can turn into a
 * sentence, when the client has no active subscription (there is nothing to
 * change) or already has a request waiting (one decision at a time). The
 * second guarantee is the database's — the partial unique index
 * `approvals_pending_subscription_change` — and the read before the insert is
 * only the fast path; the loser of a race is answered by the index and told the
 * same thing.
 */
export async function requestSubscriptionChange(
  db: Db,
  organisationId: string,
  input: RequestSubscriptionChangeInput,
): Promise<ApprovalRow> {
  const v = RequestSubscriptionChangeInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);

  const subscription = await activeSubscriptionForClient(db, organisationId, v.clientId);
  if (!subscription) {
    throw new SubscriptionChangeRefused("no_active_subscription", "There is no active plan to change.");
  }
  if (await findPendingSubscriptionChange(db, organisationId, v.clientId)) {
    throw new SubscriptionChangeRefused("already_pending", "A request is already waiting for LaunchFlow to confirm.");
  }

  const [client] = await db
    .select({ name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, v.clientId), eq(schema.clients.organisationId, organisationId)));
  const [pkg] = subscription.packageId
    ? await db
        .select({ name: schema.packages.name })
        .from(schema.packages)
        .where(and(eq(schema.packages.id, subscription.packageId), eq(schema.packages.organisationId, organisationId)))
    : [];
  const clientName = client?.name ?? "The client";
  const packageName = pkg?.name ?? "Monthly retainer";

  const payload: SubscriptionChangePayload = {
    action: SUBSCRIPTION_CHANGE_ACTION,
    clientId: v.clientId,
    clientName,
    subscriptionId: subscription.id,
    packageId: subscription.packageId,
    packageName,
    monthlyPricePence: subscription.amountPence,
    currency: subscription.currency,
    kind: v.kind,
    message: v.message,
    summary: summaryFor(clientName, v.kind, packageName, subscription.amountPence, subscription.currency, v.message),
    requestedByUserId: v.actorUserId,
  };

  let approval: ApprovalRow;
  try {
    approval = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [row] = await tx.insert(schema.approvals).values({
        organisationId,
        kind: "subscription_change",
        title: `${clientName}: ${SUBSCRIPTION_CHANGE_LABEL[v.kind].toLowerCase()}`,
        payload,
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: "client", actorId: v.actorUserId, action: "subscription.change_requested",
        targetType: "subscription", targetId: subscription.id, after: row,
      });
      await recordActivity(tx, organisationId, {
        clientId: v.clientId, actorKind: "client", actorId: v.actorUserId, kind: "subscription.change_requested",
        title: `Plan change requested: ${SUBSCRIPTION_CHANGE_LABEL[v.kind].toLowerCase()}`,
        body: v.message,
        link: "/approvals",
      });
      return row!;
    });
  } catch (error) {
    if (!isPendingSubscriptionChangeCollision(error)) throw error;
    throw new SubscriptionChangeRefused("already_pending", "A request is already waiting for LaunchFlow to confirm.");
  }

  // After commit, and never a reason to fail the request: the approvals queue
  // is the record; this is the nudge that says something is in it.
  await notifyOwner(db, organisationId, {
    kind: "subscription.change_requested",
    title: `${clientName} asks to ${SUBSCRIPTION_CHANGE_LABEL[v.kind].toLowerCase()}`,
    body: payload.summary,
    link: "/approvals",
  });

  return approval;
}
