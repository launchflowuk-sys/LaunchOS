import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { OpsBriefHighlight } from "@launchos/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export type OpsBrief = typeof schema.opsBriefs.$inferSelect;
export type { OpsBriefHighlight };

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD date");

export const OpsBriefHighlightSchema = z.object({
  label: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(500).optional(),
  /** A path in the admin portal (`/approvals`, `/tasks`) or an absolute URL. */
  link: z.string().trim().max(500).optional(),
});

export const CreateOpsBriefInput = z.object({
  briefDate: IsoDay,
  bodyMd: z.string().trim().min(1).max(20_000),
  highlights: z.array(OpsBriefHighlightSchema).max(20).default([]),
  agentRunId: z.string().uuid().optional(),
  actorKind: z.enum(["user", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateOpsBriefInput = z.input<typeof CreateOpsBriefInput>;

/**
 * Writes the day's brief. One per organisation per day: a second write for
 * the same date replaces the body and highlights in place — a re-run of the
 * morning agent, or a manual "write it again" — so the history is one entry
 * per morning and the bell only ever points at one brief for a date. The
 * audit row says whether it was a first write or a replacement.
 */
export async function createOpsBrief(db: Db, organisationId: string, input: CreateOpsBriefInput): Promise<{ brief: OpsBrief; replaced: boolean }> {
  const v = CreateOpsBriefInput.parse(input);
  const [existing] = await db
    .select()
    .from(schema.opsBriefs)
    .where(and(eq(schema.opsBriefs.organisationId, organisationId), eq(schema.opsBriefs.briefDate, v.briefDate)))
    .limit(1);

  const now = new Date();
  const [brief] = await db
    .insert(schema.opsBriefs)
    .values({
      organisationId,
      briefDate: v.briefDate,
      bodyMd: v.bodyMd,
      highlights: v.highlights,
      agentRunId: v.agentRunId ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.opsBriefs.organisationId, schema.opsBriefs.briefDate],
      set: {
        bodyMd: v.bodyMd,
        highlights: v.highlights,
        agentRunId: v.agentRunId ?? null,
        // A replaced brief has not been announced: the morning notification
        // and email are keyed on this, so a re-run tells the owner again.
        metadata: {},
        updatedAt: now,
      },
    })
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind,
    actorId: v.actorId,
    action: existing ? "ops_brief.replaced" : "ops_brief.created",
    targetType: "ops_brief",
    targetId: brief!.id,
    before: existing ? { id: existing.id, briefDate: existing.briefDate, bodyMd: existing.bodyMd, highlights: existing.highlights } : undefined,
    after: { id: brief!.id, briefDate: brief!.briefDate, bodyMd: brief!.bodyMd, highlights: brief!.highlights, agentRunId: brief!.agentRunId },
  });
  return { brief: brief!, replaced: existing !== undefined };
}

/** The most recent brief by date, or null before the first morning. */
export async function latestOpsBrief(db: Db, organisationId: string): Promise<OpsBrief | null> {
  const [row] = await db
    .select()
    .from(schema.opsBriefs)
    .where(eq(schema.opsBriefs.organisationId, organisationId))
    .orderBy(desc(schema.opsBriefs.briefDate))
    .limit(1);
  return row ?? null;
}

export const GetOpsBriefInput = z.object({ briefId: z.string().uuid() });
export type GetOpsBriefInput = z.input<typeof GetOpsBriefInput>;

export async function getOpsBrief(db: Db, organisationId: string, input: GetOpsBriefInput): Promise<OpsBrief | null> {
  const v = GetOpsBriefInput.parse(input);
  const [row] = await db
    .select()
    .from(schema.opsBriefs)
    .where(and(eq(schema.opsBriefs.organisationId, organisationId), eq(schema.opsBriefs.id, v.briefId)))
    .limit(1);
  return row ?? null;
}

export const ListOpsBriefsInput = z.object({
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).default(0),
});
export type ListOpsBriefsInput = z.input<typeof ListOpsBriefsInput>;

/** Newest first. */
export async function listOpsBriefs(db: Db, organisationId: string, input: ListOpsBriefsInput = {}): Promise<OpsBrief[]> {
  const v = ListOpsBriefsInput.parse(input);
  return db
    .select()
    .from(schema.opsBriefs)
    .where(eq(schema.opsBriefs.organisationId, organisationId))
    .orderBy(desc(schema.opsBriefs.briefDate))
    .limit(v.limit)
    .offset(v.offset);
}
