import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { createClient } from "../clients/create-client.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { queueLeadAcknowledgement } from "./acknowledge.js";
import { ATTRIBUTION_METADATA_KEY, LeadAttributionSchema, attributionOf, attributionSummary, compactAttribution, hasAttribution } from "./attribution.js";
import { BOOKING_TOKEN_KEY, mintBookingToken } from "./booking-link.js";

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
  /** `website`, `signup`, `funnel`, `api`, `referral`, `booking`, `manual`, … free text so a new form never needs a migration. */
  source: z.string().trim().min(1).max(60).default("manual"),
  /** UTM tags and click ids the form carried. Stored under `metadata.attribution`. */
  attribution: LeadAttributionSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** Off for the self-serve signup's own lead — the owner hears about that at completion. */
  notifyOwner: z.boolean().default(true),
  /**
   * Off when the caller sends its own first email (a booking confirmation).
   * On, the "we've got your enquiry" email is queued for the sources in
   * `ACKNOWLEDGED_LEAD_SOURCES` — the source rule still applies.
   */
  acknowledge: z.boolean().default(true),
  ...Actor,
});
export type CreateLeadInput = z.input<typeof CreateLeadInput>;

/**
 * A new enquiry. Public-facing (the website form posts here through the
 * rate-limited route), so every field is bounded and nothing is trusted.
 *
 * In one transaction: the row (with a fresh `metadata.bookingToken` and the
 * attribution), the audit row and — for a website/signup/funnel/api lead with
 * an email — the acknowledgement email queued on the lead's own thread. After
 * commit: the owner's bell (`lead.created`, urgent), then `lead.created` and
 * `message.queued` are emitted so the worker starts the Lead Qualifier and
 * sends the acknowledgement. Nothing is emitted for a row the transaction
 * rolled back.
 */
export async function createLead(db: Db, organisationId: string, input: CreateLeadInput, env: NodeJS.ProcessEnv = process.env): Promise<LeadRow> {
  const v = CreateLeadInput.parse(input);
  const attribution = compactAttribution(v.attribution ?? {});
  const metadata = {
    ...v.metadata,
    [BOOKING_TOKEN_KEY]: mintBookingToken(),
    ...(hasAttribution(attribution) ? { [ATTRIBUTION_METADATA_KEY]: attribution } : {}),
  };
  const created = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.leads).values({
      organisationId,
      name: v.name,
      email: v.email?.toLowerCase() ?? null,
      phone: v.phone ?? null,
      business: v.business ?? null,
      message: v.message ?? null,
      source: v.source,
      metadata,
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "lead.created", targetType: "lead", targetId: row!.id, after: row,
    });
    const acknowledgement = v.acknowledge ? await queueLeadAcknowledgement(tx, organisationId, { lead: row! }, env) : undefined;
    // The acknowledgement stamps the row; hand the caller the stamped version.
    const [lead] = await tx.select().from(schema.leads).where(eq(schema.leads.id, row!.id));
    return { lead: lead!, acknowledgement };
  });
  const lead = created.lead;
  if (v.notifyOwner) {
    const campaign = attributionSummary(attribution);
    await notifyOwner(db, organisationId, {
      kind: LEAD_NOTIFICATION_KIND,
      title: `New lead: ${lead.business ?? lead.name}`,
      body:
        [lead.name, lead.email, lead.phone].filter(Boolean).join(" · ") +
        (campaign ? `\nCampaign: ${campaign}` : "") +
        (lead.message ? `\n${lead.message.slice(0, 300)}` : ""),
      link: `/leads/${lead.id}`,
    });
  }
  await emit({ name: "lead.created", organisationId, leadId: lead.id });
  if (created.acknowledgement) {
    await emit({ name: "message.queued", organisationId, messageId: created.acknowledgement.id });
  }
  return lead;
}

export const ListLeadsInput = z.object({
  status: z.enum(schema.leadStatusEnum.enumValues).optional(),
  /** Exact match on `metadata.attribution.utmCampaign`. */
  utmCampaign: z.string().trim().min(1).max(200).optional(),
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
    v.utmCampaign ? sql`${schema.leads.metadata}->${ATTRIBUTION_METADATA_KEY}->>'utmCampaign' = ${v.utmCampaign}` : undefined,
  );
  const [leads, [total]] = await Promise.all([
    db.select().from(schema.leads).where(where).orderBy(desc(schema.leads.createdAt), desc(schema.leads.id)).limit(v.limit).offset(v.offset),
    db.select({ value: count() }).from(schema.leads).where(where),
  ]);
  return { leads, total: total?.value ?? 0 };
}

export const LeadCampaignCountsInput = z.object({
  days: z.number().int().min(1).max(365).default(30),
  now: z.date().optional(),
});
export type LeadCampaignCountsInput = z.input<typeof LeadCampaignCountsInput>;

export interface LeadCampaignCount {
  /** The `utmCampaign` value, or null for leads with none. */
  campaign: string | null;
  leads: number;
  converted: number;
}

/** Leads per campaign over the last N days, most first; the null row is "no campaign". */
export async function leadCampaignCounts(db: Db, organisationId: string, input: LeadCampaignCountsInput = {}): Promise<{ days: number; since: Date; campaigns: LeadCampaignCount[] }> {
  const v = LeadCampaignCountsInput.parse(input);
  const now = v.now ?? new Date();
  const since = new Date(now.getTime() - v.days * 86_400_000);
  // A literal path, not a parameter: Postgres requires the GROUP BY expression to
  // be textually the same as the selected one, and two `$n` placeholders are not.
  const campaign = sql<string | null>`${schema.leads.metadata}->${sql.raw(`'${ATTRIBUTION_METADATA_KEY}'`)}->>'utmCampaign'`;
  const rows = await db
    .select({
      campaign,
      leads: count(),
      converted: sql<number>`count(*) filter (where ${schema.leads.status} = 'converted')`,
    })
    .from(schema.leads)
    .where(and(eq(schema.leads.organisationId, organisationId), isNull(schema.leads.deletedAt), gte(schema.leads.createdAt, since)))
    .groupBy(campaign)
    .orderBy(desc(count()), campaign);
  return {
    days: v.days,
    since,
    campaigns: rows.map((r) => ({ campaign: r.campaign, leads: Number(r.leads), converted: Number(r.converted) })),
  };
}

export const LeadsAwaitingReplyInput = z.object({
  hours: z.number().min(0).default(24),
  now: z.date().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type LeadsAwaitingReplyInput = z.input<typeof LeadsAwaitingReplyInput>;

/**
 * Leads still `new` — nobody has written back — older than `hours`. What the
 * Ops Brief lists under "waiting for a reply". Oldest first.
 */
export async function leadsAwaitingReply(db: Db, organisationId: string, input: LeadsAwaitingReplyInput = {}): Promise<LeadRow[]> {
  const v = LeadsAwaitingReplyInput.parse(input);
  const now = v.now ?? new Date();
  const cutoff = new Date(now.getTime() - v.hours * 3_600_000);
  return db.select().from(schema.leads)
    .where(and(
      eq(schema.leads.organisationId, organisationId),
      isNull(schema.leads.deletedAt),
      eq(schema.leads.status, "new"),
      lte(schema.leads.createdAt, cutoff),
    ))
    .orderBy(schema.leads.createdAt, schema.leads.id)
    .limit(v.limit);
}

export async function getLead(db: Db, organisationId: string, leadId: string): Promise<LeadRow | null> {
  const [row] = await db.select().from(schema.leads)
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.organisationId, organisationId), isNull(schema.leads.deletedAt)));
  return row ?? null;
}

/** The lead plus its attribution, decoded — what the admin page and the qualifier read. */
export async function getLeadWithAttribution(db: Db, organisationId: string, leadId: string) {
  const lead = await getLead(db, organisationId, leadId);
  return lead ? { ...lead, attribution: attributionOf(lead.metadata) } : null;
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

/**
 * Moves a `new` lead to `contacted` the moment we first write to them — the
 * approved reply, a booked call. Anything past `new` is left alone, so a
 * booking after a conversion never regresses the lead. Runs in the caller's
 * transaction; returns the row as it now is.
 */
export async function markLeadContacted(db: Db, organisationId: string, leadId: string, actor: { actorKind: "user" | "client" | "agent" | "system"; actorId?: string | undefined }): Promise<LeadRow> {
  const [before] = await db.select().from(schema.leads)
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.organisationId, organisationId)));
  if (!before) throw new Error(`lead ${leadId} not found in organisation`);
  if (before.status !== "new") return before;
  const [after] = await db.update(schema.leads)
    .set({ status: "contacted", updatedAt: new Date() })
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.organisationId, organisationId), eq(schema.leads.status, "new")))
    .returning();
  if (!after) return before;
  await recordAudit(db, organisationId, {
    actorKind: actor.actorKind, actorId: actor.actorId, action: "lead.status_changed", targetType: "lead", targetId: leadId, before, after,
  });
  return after;
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
    // The lead's thread and meetings follow them to the client record.
    await tx.update(schema.conversations).set({ clientId: client.id, updatedAt: new Date() })
      .where(and(eq(schema.conversations.organisationId, organisationId), eq(schema.conversations.leadId, lead.id), isNull(schema.conversations.clientId)));
    await tx.update(schema.meetings).set({ clientId: client.id, updatedAt: new Date() })
      .where(and(eq(schema.meetings.organisationId, organisationId), eq(schema.meetings.leadId, lead.id), isNull(schema.meetings.clientId)));
    return after!;
  });
  return { lead: converted, client };
}
