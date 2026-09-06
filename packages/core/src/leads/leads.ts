import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { createClient } from "../clients/create-client.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export type LeadRow = typeof schema.leads.$inferSelect;
export const LEAD_STATUSES = schema.leadStatusEnum.enumValues;

/** Urgent — new business is the one thing worth a buzz on the phone. */
export const LEAD_NOTIFICATION_KIND = "lead.created";

const Actor = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

export const CreateLeadInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  business: z.string().trim().max(200).optional(),
  message: z.string().trim().max(4000).optional(),
  /** `website`, `signup`, `referral`, `manual`, … free text so a new form never needs a migration. */
  source: z.string().trim().min(1).max(60).default("manual"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** Off for the self-serve signup's own lead — the owner hears about that at completion. */
  notifyOwner: z.boolean().default(true),
  ...Actor,
});
export type CreateLeadInput = z.input<typeof CreateLeadInput>;

/**
 * A new enquiry. Public-facing (the website form posts here through the
 * rate-limited route), so every field is bounded and nothing is trusted.
 * Audited, and the owner's bell rings with `lead.created` — an urgent kind.
 */
export async function createLead(db: Db, organisationId: string, input: CreateLeadInput): Promise<LeadRow> {
  const v = CreateLeadInput.parse(input);
  const lead = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.leads).values({
      organisationId,
      name: v.name,
      email: v.email?.toLowerCase() ?? null,
      phone: v.phone ?? null,
      business: v.business ?? null,
      message: v.message ?? null,
      source: v.source,
      metadata: v.metadata,
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "lead.created", targetType: "lead", targetId: row!.id, after: row,
    });
    return row!;
  });
  if (v.notifyOwner) {
    await notifyOwner(db, organisationId, {
      kind: LEAD_NOTIFICATION_KIND,
      title: `New lead: ${lead.business ?? lead.name}`,
      body: [lead.name, lead.email, lead.phone].filter(Boolean).join(" · ") + (lead.message ? `\n${lead.message.slice(0, 300)}` : ""),
      link: `/leads/${lead.id}`,
    });
  }
  return lead;
}

export const ListLeadsInput = z.object({
  status: z.enum(schema.leadStatusEnum.enumValues).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListLeadsInput = z.input<typeof ListLeadsInput>;

export async function listLeads(db: Db, organisationId: string, input: ListLeadsInput = {}): Promise<{ leads: LeadRow[]; total: number }> {
  const v = ListLeadsInput.parse(input);
  const where = and(
    eq(schema.leads.organisationId, organisationId),
    isNull(schema.leads.deletedAt),
    v.status ? eq(schema.leads.status, v.status) : undefined,
  );
  const [leads, [total]] = await Promise.all([
    db.select().from(schema.leads).where(where).orderBy(desc(schema.leads.createdAt), desc(schema.leads.id)).limit(v.limit).offset(v.offset),
    db.select({ value: count() }).from(schema.leads).where(where),
  ]);
  return { leads, total: total?.value ?? 0 };
}

export async function getLead(db: Db, organisationId: string, leadId: string): Promise<LeadRow | null> {
  const [row] = await db.select().from(schema.leads)
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.organisationId, organisationId), isNull(schema.leads.deletedAt)));
  return row ?? null;
}

export const UpdateLeadStatusInput = z.object({
  leadId: z.string().uuid(),
  status: z.enum(schema.leadStatusEnum.enumValues),
  actorId: z.string().min(1),
});
export type UpdateLeadStatusInput = z.input<typeof UpdateLeadStatusInput>;

/** `converted` is reached through `convertLeadToClient`, which links the client; setting it by hand is refused. */
export async function updateLeadStatus(db: Db, organisationId: string, input: UpdateLeadStatusInput): Promise<LeadRow> {
  const v = UpdateLeadStatusInput.parse(input);
  if (v.status === "converted") throw new Error("use convertLeadToClient to convert a lead");
  const before = await getLead(db, organisationId, v.leadId);
  if (!before) throw new Error(`lead ${v.leadId} not found in organisation`);
  if (before.status === "converted") throw new Error("a converted lead cannot change status");
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.leads)
      .set({ status: v.status, updatedAt: new Date() })
      .where(and(eq(schema.leads.id, v.leadId), eq(schema.leads.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "lead.status_changed", targetType: "lead", targetId: v.leadId, before, after,
    });
    return after!;
  });
}

export const ConvertLeadToClientInput = z.object({
  leadId: z.string().uuid(),
  actorId: z.string().min(1),
  /** Override the client name; defaults to the business, then the person. */
  name: z.string().trim().min(1).max(200).optional(),
  packageId: z.string().uuid().optional(),
});
export type ConvertLeadToClientInput = z.input<typeof ConvertLeadToClientInput>;

/**
 * Makes a client out of a lead — `createClient` with what the lead knows —
 * and links the two. Refused for a lead already converted, so a double click
 * cannot make two clients. The client's `client.created` event still fires
 * from `createClient`, so onboarding tasks generate as for any new client.
 */
export async function convertLeadToClient(db: Db, organisationId: string, input: ConvertLeadToClientInput) {
  const v = ConvertLeadToClientInput.parse(input);
  const lead = await getLead(db, organisationId, v.leadId);
  if (!lead) throw new Error(`lead ${v.leadId} not found in organisation`);
  if (lead.status === "converted" || lead.clientId) throw new Error("this lead has already been converted");
  if (v.packageId) await assertOwned(db, organisationId, schema.packages, v.packageId);

  const client = await createClient(db, organisationId, {
    name: v.name ?? lead.business ?? lead.name,
    ...(lead.email ? { email: lead.email } : {}),
    ...(lead.phone ? { phone: lead.phone } : {}),
    ...(v.packageId ? { packageId: v.packageId } : {}),
    ...(lead.message ? { notes: `From lead (${lead.source}): ${lead.message}` } : {}),
    actorKind: "user",
    actorId: v.actorId,
  });

  const converted = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.leads)
      .set({ status: "converted", clientId: client.id, updatedAt: new Date() })
      .where(and(eq(schema.leads.id, lead.id), eq(schema.leads.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "lead.converted", targetType: "lead", targetId: lead.id, before: lead, after,
    });
    await recordActivity(tx, organisationId, {
      clientId: client.id, actorKind: "user", actorId: v.actorId, kind: "lead.converted",
      title: `Converted from a ${lead.source} lead`, link: `/leads/${lead.id}`,
    });
    return after!;
  });
  return { lead: converted, client };
}
