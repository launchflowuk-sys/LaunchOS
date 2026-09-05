import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";
import { ActorKindSchema, type ContentBriefRow } from "./shared.js";

const BriefText = z.string().trim().max(4000).optional();

export const UpsertContentBriefInput = z.object({
  clientId: z.string().uuid(),
  tone: BriefText,
  audience: BriefText,
  services: BriefText,
  offers: BriefText,
  area: BriefText,
  doNotSay: BriefText,
  notes: BriefText,
  actorKind: ActorKindSchema.default("user"),
  /** The staff user editing the brief; stamped as `updated_by_user_id` when it is a user. */
  actorId: z.string().min(1).optional(),
});
export type UpsertContentBriefInput = z.input<typeof UpsertContentBriefInput>;

export const GetContentBriefInput = z.object({ clientId: z.string().uuid() });
export type GetContentBriefInput = z.input<typeof GetContentBriefInput>;

const nullable = (value: string | undefined) => (value === undefined || value === "" ? null : value);

/**
 * The client's voice, one row per client. Every field is replaced by what is
 * passed (an omitted or blank field becomes null) — the form sends the whole
 * brief every time, so a partial merge would resurrect text somebody cleared.
 */
export async function upsertContentBrief(db: Db, organisationId: string, input: UpsertContentBriefInput): Promise<ContentBriefRow> {
  const v = UpsertContentBriefInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);

  const fields = {
    tone: nullable(v.tone),
    audience: nullable(v.audience),
    services: nullable(v.services),
    offers: nullable(v.offers),
    area: nullable(v.area),
    doNotSay: nullable(v.doNotSay),
    notes: nullable(v.notes),
    updatedByUserId: v.actorKind === "user" && v.actorId ? v.actorId : null,
  };

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx.select().from(schema.contentBriefs).where(and(
      eq(schema.contentBriefs.organisationId, organisationId),
      eq(schema.contentBriefs.clientId, v.clientId),
    ));
    const [after] = await tx.insert(schema.contentBriefs)
      .values({ organisationId, clientId: v.clientId, ...fields })
      .onConflictDoUpdate({
        target: [schema.contentBriefs.organisationId, schema.contentBriefs.clientId],
        set: { ...fields, updatedAt: new Date() },
      })
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: before ? "content_brief.updated" : "content_brief.created",
      targetType: "content_brief", targetId: after!.id, before: before ?? null, after,
    });
    return after!;
  });
}

export async function getContentBrief(db: Db, organisationId: string, input: GetContentBriefInput): Promise<ContentBriefRow | undefined> {
  const v = GetContentBriefInput.parse(input);
  const [row] = await db.select().from(schema.contentBriefs).where(and(
    eq(schema.contentBriefs.organisationId, organisationId),
    eq(schema.contentBriefs.clientId, v.clientId),
    isNull(schema.contentBriefs.deletedAt),
  ));
  return row;
}
