import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";

export const CreateTicketInput = z.object({
  clientId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  category: z.enum(["hosting", "dns", "content", "email", "ads", "billing", "other"]).optional(),
  source: z.enum(["portal", "email", "agent", "monitor", "manual"]),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateTicketInput = z.input<typeof CreateTicketInput>;

export async function createTicket(db: Db, organisationId: string, input: CreateTicketInput) {
  const v = CreateTicketInput.parse(input);
  const [conversation] = await db.insert(schema.conversations).values({
    organisationId, clientId: v.clientId, siteId: v.siteId ?? null, subject: v.subject, channel: "internal", lastMessageAt: new Date(),
  }).returning();
  await db.insert(schema.messages).values({
    organisationId, conversationId: conversation!.id, direction: "internal", authorKind: v.actorKind, authorId: v.actorId ?? null, body: v.body,
  });
  const [ticket] = await db.insert(schema.tickets).values({
    organisationId, conversationId: conversation!.id, clientId: v.clientId, siteId: v.siteId ?? null,
    subject: v.subject, severity: v.severity, category: v.category ?? null, source: v.source,
  }).returning();
  await db.insert(schema.ticketEvents).values({ organisationId, ticketId: ticket!.id, kind: "created", actorKind: v.actorKind, actorId: v.actorId ?? null });
  await recordAudit(db, organisationId, { actorKind: v.actorKind, actorId: v.actorId, action: "ticket.created", targetType: "ticket", targetId: ticket!.id, after: ticket });
  await emit({ name: "ticket.created", organisationId, ticketId: ticket!.id });
  return { ticket: ticket!, conversation: conversation! };
}
