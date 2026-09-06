import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";
import { appUrl, brandSupportAddress } from "../config.js";
import { caseReference } from "../support/acknowledge-ticket.js";
import { CSAT_INVITE_KIND } from "../support/courtesy-notice.js";

type Ticket = typeof schema.tickets.$inferSelect;
type Message = typeof schema.messages.$inferSelect;

/** Stamped on `tickets.metadata` once the invite is queued — at most one per case. */
export const CSAT_INVITED_AT = "csatInvitedAt";

export const CSAT_SCORES = [1, 2, 3, 4, 5] as const;
export const CSAT_SCORE_LABELS: Readonly<Record<(typeof CSAT_SCORES)[number], string>> = {
  1: "Very poor", 2: "Poor", 3: "OK", 4: "Good", 5: "Excellent",
};

/** The portal page that records a score; `?score=N` pre-selects it. */
export function csatRatePath(ticketId: string, score?: number): string {
  return `/portal/support/${ticketId}/rate${score ? `?score=${score}` : ""}`;
}

/**
 * The stored body — the record of what the client was told. Five plain links
 * so the email works in any client; the branded shell adds a "Rate your
 * experience" button to the same page.
 */
export function csatInviteBody(ticket: Pick<Ticket, "id" | "subject">, base: string): string {
  const lines = CSAT_SCORES.map((score) => `${score} — ${CSAT_SCORE_LABELS[score]}: ${base}${csatRatePath(ticket.id, score)}`);
  return (
    `Your case '${ticket.subject}' (#${caseReference(ticket.id)}) has been marked as resolved. ` +
    `Was this sorted to your satisfaction? Tap a number to let us know — it takes a second and it helps us do better.\n\n` +
    `${lines.join("\n")}\n\n` +
    `If it is not actually sorted, reply on the case in your portal and we will pick it straight back up.`
  );
}

/** Active portal users of the client, falling back to the client's own address. */
async function recipientAddresses(db: Db, organisationId: string, clientId: string): Promise<string[]> {
  const users = await db
    .select({ email: schema.user.email })
    .from(schema.clientUsers)
    .innerJoin(schema.user, eq(schema.clientUsers.userId, schema.user.id))
    .where(and(
      eq(schema.clientUsers.organisationId, organisationId),
      eq(schema.clientUsers.clientId, clientId),
      eq(schema.clientUsers.status, "active"),
    ));
  const addresses = [...new Set(users.map((u) => u.email.trim().toLowerCase()).filter(Boolean))];
  if (addresses.length > 0) return addresses;
  const [client] = await db
    .select({ email: schema.clients.email })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  return client?.email ? [client.email] : [];
}

export interface QueueCsatInviteInput {
  ticket: Ticket;
  now?: Date | undefined;
}

/**
 * Queues "Was this sorted?" for a case that has just been resolved.
 *
 * Only for a case the client can see: an internal case has no client to ask.
 * At most once per ticket (`tickets.metadata.csatInvitedAt`), so a case that
 * is resolved, reopened and resolved again asks once. Written as `queued`
 * outbound messages on the case's own conversation — one per portal user —
 * marked `metadata.kind = csat_invite`, so `sendQueuedMessage` renders the
 * branded shell and every thread reader hides it. Runs inside the caller's
 * transaction (`updateTicket`) and never fails it: no address means no email.
 * The caller emits `message.queued` for each row returned after its commit.
 */
export async function queueCsatInvite(
  db: Db,
  organisationId: string,
  input: QueueCsatInviteInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Message[]> {
  const { ticket } = input;
  const now = input.now ?? new Date();
  if (!ticket.clientVisible || ticket.metadata[CSAT_INVITED_AT]) return [];

  const recipients = await recipientAddresses(db, organisationId, ticket.clientId);
  if (recipients.length === 0) return [];

  const [conversation] = ticket.conversationId
    ? await db.select().from(schema.conversations)
        .where(and(eq(schema.conversations.id, ticket.conversationId), eq(schema.conversations.organisationId, organisationId)))
    : [];
  const conversationId = conversation?.id ?? (await db.insert(schema.conversations).values({
    organisationId, clientId: ticket.clientId, subject: ticket.subject, channel: "portal", status: "closed", lastMessageAt: now, ticketId: ticket.id,
  }).returning())[0]!.id;

  const [identity] = await db
    .select({ address: schema.emailIdentities.address })
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, ticket.clientId)));
  const from = identity?.address ?? brandSupportAddress(env);
  const body = csatInviteBody(ticket, appUrl(env));

  const notices: Message[] = [];
  for (const to of recipients) {
    const [message] = await db.insert(schema.messages).values({
      organisationId,
      conversationId,
      direction: "outbound",
      authorKind: "system",
      authorId: null,
      body,
      fromEmail: from,
      toEmail: to,
      subject: `Was this sorted? Case #${caseReference(ticket.id)}`,
      status: "queued",
      metadata: { kind: CSAT_INVITE_KIND, ticketId: ticket.id },
    }).returning();
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "message.queued", targetType: "message", targetId: message!.id, after: message,
    });
    notices.push(message!);
  }

  const stamp = { [CSAT_INVITED_AT]: now.toISOString(), csatInviteMessageIds: notices.map((n) => n.id) };
  await db.update(schema.tickets)
    .set({
      metadata: sql`coalesce(${schema.tickets.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(schema.tickets.id, ticket.id), eq(schema.tickets.organisationId, organisationId)));
  return notices;
}
