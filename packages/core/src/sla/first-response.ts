import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { firstResponseHours } from "../config.js";
import { notify, notifyOwner } from "../notifications/notify.js";
import { caseReference } from "../support/acknowledge-ticket.js";

export type TicketRow = typeof schema.tickets.$inferSelect;

/** Stamped on `tickets.metadata` once the breach has been announced — the "once per case" guard. */
export const SLA_BREACH_NOTIFIED_AT = "slaBreachNotifiedAt";

/** The notification kind, urgent (see `URGENT_NOTIFICATION_KINDS`). */
export const SLA_BREACH_NOTIFICATION_KIND = "case.sla_breached";

/** A case still waiting on us. `waiting_client` is the client's turn, so it is not counted. */
export const AWAITING_RESPONSE_STATUSES = ["open", "triaged", "in_progress"] as const;

export const CasesPastFirstResponseInput = z.object({
  /** Working-hours promise; defaults to the organisation's `firstResponseHours` (4). */
  hours: z.number().positive().max(24 * 30).optional(),
  now: z.coerce.date().default(() => new Date()),
  /** Include cases already announced. Off by default so the sweep only sees new breaches. */
  includeNotified: z.boolean().default(false),
});
export type CasesPastFirstResponseInput = z.input<typeof CasesPastFirstResponseInput>;

async function promisedHours(db: Db, organisationId: string, hours: number | undefined): Promise<number> {
  if (hours !== undefined) return hours;
  const [organisation] = await db
    .select({ metadata: schema.organisations.metadata })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  return firstResponseHours(organisation?.metadata);
}

/**
 * Every open, client-visible case with no first response after the promised
 * hours. Calendar hours, like `slaDueAt`: business-hours arithmetic is not in
 * v1 and the acknowledgement email quotes the same number.
 */
export async function casesPastFirstResponse(db: Db, organisationId: string, input: CasesPastFirstResponseInput = {}): Promise<TicketRow[]> {
  const v = CasesPastFirstResponseInput.parse(input);
  const hours = await promisedHours(db, organisationId, v.hours);
  const cutoff = new Date(v.now.getTime() - hours * 60 * 60 * 1000);
  return db
    .select()
    .from(schema.tickets)
    .where(and(
      eq(schema.tickets.organisationId, organisationId),
      eq(schema.tickets.clientVisible, true),
      inArray(schema.tickets.status, [...AWAITING_RESPONSE_STATUSES]),
      isNull(schema.tickets.firstResponseAt),
      isNull(schema.tickets.deletedAt),
      lte(schema.tickets.createdAt, cutoff),
      v.includeNotified ? undefined : sql`${schema.tickets.metadata}->>${SLA_BREACH_NOTIFIED_AT} is null`,
    ))
    .orderBy(asc(schema.tickets.createdAt));
}

export const NotifySlaBreachesInput = CasesPastFirstResponseInput.omit({ includeNotified: true });
export type NotifySlaBreachesInput = z.input<typeof NotifySlaBreachesInput>;

export interface SlaBreachResult {
  hours: number;
  breached: number;
  notified: string[];
}

/**
 * The 15-minute sweep's whole job: find the breaches nobody has been told
 * about, tell the owner and the assignee (once each), and stamp the case so
 * the next sweep skips it. The stamp is a conditional UPDATE — only the sweep
 * that flips `slaBreachNotifiedAt` from null sends the notification, so two
 * overlapping sweeps cannot announce the same case twice.
 */
export async function notifySlaBreaches(db: Db, organisationId: string, input: NotifySlaBreachesInput = {}): Promise<SlaBreachResult> {
  const v = NotifySlaBreachesInput.parse(input);
  const hours = await promisedHours(db, organisationId, v.hours);
  const breached = await casesPastFirstResponse(db, organisationId, { hours, now: v.now });
  const notified: string[] = [];

  for (const ticket of breached) {
    const stamp = { [SLA_BREACH_NOTIFIED_AT]: v.now.toISOString() };
    const [claimed] = await db
      .update(schema.tickets)
      .set({
        metadata: sql`coalesce(${schema.tickets.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
        updatedAt: v.now,
      })
      .where(and(
        eq(schema.tickets.id, ticket.id),
        eq(schema.tickets.organisationId, organisationId),
        sql`${schema.tickets.metadata}->>${SLA_BREACH_NOTIFIED_AT} is null`,
      ))
      .returning();
    if (!claimed) continue;

    const ageHours = Math.floor((v.now.getTime() - ticket.createdAt.getTime()) / 3_600_000);
    const title = `Case #${caseReference(ticket.id)} has had no reply for ${ageHours}h`;
    const body = `"${ticket.subject}" was promised a first reply within ${hours} hours. Nobody has answered yet.`;
    const link = `/cases/${ticket.id}`;
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "ticket.sla_breached", targetType: "ticket", targetId: ticket.id,
      before: ticket, after: claimed,
    });
    const owner = await notifyOwner(db, organisationId, { kind: SLA_BREACH_NOTIFICATION_KIND, title, body, link });
    if (ticket.assignedUserId && ticket.assignedUserId !== owner?.userId) {
      await notify(db, organisationId, { userId: ticket.assignedUserId, kind: SLA_BREACH_NOTIFICATION_KIND, title, body, link })
        // A suspended assignee is not a reason to lose the owner's alert.
        .catch(() => undefined);
    }
    notified.push(ticket.id);
  }
  return { hours, breached: breached.length, notified };
}
