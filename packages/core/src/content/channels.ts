import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";
import { ActorKindSchema, ContentChannelSchema, type ContentChannelRow } from "./shared.js";

export const SetContentChannelInput = z.object({
  clientId: z.string().uuid(),
  channel: ContentChannelSchema,
  /** Facebook Page id, Instagram Business user id, LaunchOS site id (blog) or GBP location id. */
  externalId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().max(200).optional(),
  enabled: z.boolean().default(true),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().min(1).optional(),
});
export type SetContentChannelInput = z.input<typeof SetContentChannelInput>;

export const ListContentChannelsInput = z.object({
  clientId: z.string().uuid(),
  enabledOnly: z.boolean().default(false),
});
export type ListContentChannelsInput = z.input<typeof ListContentChannelsInput>;

/**
 * Where a client's posts land. One row per (client, channel); setting it
 * again replaces the id and name, so re-connecting a Page is the same call.
 */
export async function setContentChannel(db: Db, organisationId: string, input: SetContentChannelInput): Promise<ContentChannelRow> {
  const v = SetContentChannelInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);

  const fields = { externalId: v.externalId, displayName: v.displayName ?? null, enabled: v.enabled };

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx.select().from(schema.contentChannels).where(and(
      eq(schema.contentChannels.organisationId, organisationId),
      eq(schema.contentChannels.clientId, v.clientId),
      eq(schema.contentChannels.channel, v.channel),
    ));
    const [after] = await tx.insert(schema.contentChannels)
      .values({ organisationId, clientId: v.clientId, channel: v.channel, ...fields })
      .onConflictDoUpdate({
        target: [schema.contentChannels.organisationId, schema.contentChannels.clientId, schema.contentChannels.channel],
        set: { ...fields, deletedAt: null, updatedAt: new Date() },
      })
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: before ? "content_channel.updated" : "content_channel.created",
      targetType: "content_channel", targetId: after!.id, before: before ?? null, after,
    });
    return after!;
  });
}

export async function listContentChannels(db: Db, organisationId: string, input: ListContentChannelsInput): Promise<ContentChannelRow[]> {
  const v = ListContentChannelsInput.parse(input);
  return db.select().from(schema.contentChannels).where(and(
    eq(schema.contentChannels.organisationId, organisationId),
    eq(schema.contentChannels.clientId, v.clientId),
    isNull(schema.contentChannels.deletedAt),
    ...(v.enabledOnly ? [eq(schema.contentChannels.enabled, true)] : []),
  )).orderBy(asc(schema.contentChannels.channel));
}
