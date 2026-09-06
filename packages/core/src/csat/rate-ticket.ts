import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notify, notifyOwner } from "../notifications/notify.js";
import { caseReference } from "../support/acknowledge-ticket.js";
import { CSAT_SCORE_LABELS } from "./invite.js";

export type TicketRatingRow = typeof schema.ticketRatings.$inferSelect;

/** A score at or below this tells the owner straight away. */
export const CSAT_LOW_SCORE = 2;
export const CSAT_LOW_SCORE_NOTIFICATION_KIND = "csat.low_score";

export class CsatRefused extends Error {
  constructor(readonly reason: "not_found" | "not_resolved" | "not_portal_user", message: string) {
    super(message);
    this.name = "CsatRefused";
  }
}

export const RateTicketInput = z.object({
  ticketId: z.string().uuid(),
  /** The Better Auth user id of the portal user rating it. */
  actorUserId: z.string().min(1),
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
});
export type RateTicketInput = z.input<typeof RateTicketInput>;

/**
 * Records how the client felt about a resolved case. The rater must be an
 * active portal user of the case's client and the case must be visible to
 * them and resolved (or closed). One rating per case: rating again replaces
 * the score and the comment. A low score raises `csat.low_score` for the
 * owner and the assignee — that is a conversation to have today.
 */
export async function rateTicket(db: Db, organisationId: string, input: RateTicketInput): Promise<TicketRatingRow> {
  const v = RateTicketInput.parse(input);
  const [ticket] = await db.select().from(schema.tickets)
    .where(and(eq(schema.tickets.id, v.ticketId), eq(schema.tickets.organisationId, organisationId)));
  if (!ticket || !ticket.clientVisible) throw new CsatRefused("not_found", "That case could not be found.");
  if (ticket.status !== "resolved" && ticket.status !== "closed") {
    throw new CsatRefused("not_resolved", "This case is still open — you can rate it once it has been resolved.");
  }
  const [portalUser] = await db.select({ id: schema.clientUsers.id }).from(schema.clientUsers).where(and(
    eq(schema.clientUsers.organisationId, organisationId),
    eq(schema.clientUsers.clientId, ticket.clientId),
    eq(schema.clientUsers.userId, v.actorUserId),
    eq(schema.clientUsers.status, "active"),
  ));
  if (!portalUser) throw new CsatRefused("not_portal_user", "Only the client's portal users can rate this case.");

  const now = new Date();
  const rating = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx.select().from(schema.ticketRatings).where(eq(schema.ticketRatings.ticketId, ticket.id));
    const [row] = await tx.insert(schema.ticketRatings)
      .values({ organisationId, ticketId: ticket.id, clientUserId: v.actorUserId, score: v.score, comment: v.comment ?? null, ratedAt: now })
      .onConflictDoUpdate({
        target: schema.ticketRatings.ticketId,
        set: { clientUserId: v.actorUserId, score: v.score, comment: v.comment ?? null, ratedAt: now, updatedAt: now },
      })
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: "client", actorId: v.actorUserId, action: before ? "ticket.rating_changed" : "ticket.rated",
      targetType: "ticket", targetId: ticket.id, before: before ?? null, after: row,
    });
    await recordActivity(tx, organisationId, {
      clientId: ticket.clientId, actorKind: "client", actorId: v.actorUserId, kind: "ticket.rated",
      title: `Case #${caseReference(ticket.id)} rated ${v.score}/5 — ${CSAT_SCORE_LABELS[v.score as 1 | 2 | 3 | 4 | 5]}`,
      ...(v.comment ? { body: v.comment } : {}),
      link: `/cases/${ticket.id}`,
    });
    return row!;
  });

  if (v.score <= CSAT_LOW_SCORE) {
    const title = `A client rated case #${caseReference(ticket.id)} ${v.score}/5`;
    const body = `"${ticket.subject}"${v.comment ? ` — they said: ${v.comment.slice(0, 500)}` : ""}`;
    const link = `/cases/${ticket.id}`;
    const owner = await notifyOwner(db, organisationId, { kind: CSAT_LOW_SCORE_NOTIFICATION_KIND, title, body, link });
    if (ticket.assignedUserId && ticket.assignedUserId !== owner?.userId) {
      await notify(db, organisationId, { userId: ticket.assignedUserId, kind: CSAT_LOW_SCORE_NOTIFICATION_KIND, title, body, link })
        .catch(() => undefined);
    }
  }
  return rating;
}

export const GetTicketRatingInput = z.object({ ticketId: z.string().uuid() });
export type GetTicketRatingInput = z.input<typeof GetTicketRatingInput>;

export async function getTicketRating(db: Db, organisationId: string, input: GetTicketRatingInput): Promise<TicketRatingRow | null> {
  const v = GetTicketRatingInput.parse(input);
  const [row] = await db.select().from(schema.ticketRatings)
    .where(and(eq(schema.ticketRatings.ticketId, v.ticketId), eq(schema.ticketRatings.organisationId, organisationId)));
  return row ?? null;
}
