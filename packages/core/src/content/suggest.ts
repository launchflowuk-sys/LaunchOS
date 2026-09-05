import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";
import {
  CHANNEL_LABEL, ContentChannelSchema, ContentRefused, KIND_FOR_CHANNEL, MAX_CONTENT_BODY_CHARS, excerpt, periodKeyFor,
  type ContentItemRow,
} from "./shared.js";

export const SuggestContentItemInput = z.object({
  clientId: z.string().uuid(),
  /** The Better Auth user id of the portal user suggesting it. */
  actorUserId: z.string().min(1),
  text: z.string().trim().min(1).max(MAX_CONTENT_BODY_CHARS),
  linkUrl: z.string().trim().url().max(2000).optional(),
  /** Where they would like it to go; the owner can change it. Facebook by default. */
  channel: ContentChannelSchema.default("facebook"),
});
export type SuggestContentItemInput = z.input<typeof SuggestContentItemInput>;

/**
 * A client suggesting a post from the portal. It lands as a draft with
 * `source = client` in the current month, and the owner is told — nothing
 * is written for the client, nothing is scheduled, nothing goes out until a
 * person picks it up, sends it for approval and approves it.
 *
 * The caller is verified as an *active portal user of this client* rather than
 * trusted: a portal session for one client must not be able to file drafts
 * against another, even inside the same organisation.
 */
export async function suggestContentItem(db: Db, organisationId: string, input: SuggestContentItemInput): Promise<ContentItemRow> {
  const v = SuggestContentItemInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);

  const [membership] = await db.select({ id: schema.clientUsers.id }).from(schema.clientUsers).where(and(
    eq(schema.clientUsers.organisationId, organisationId),
    eq(schema.clientUsers.clientId, v.clientId),
    eq(schema.clientUsers.userId, v.actorUserId),
    eq(schema.clientUsers.status, "active"),
  ));
  if (!membership) throw new ContentRefused("not_portal_user", "Only a portal user of this client can suggest a post.");

  const [client] = await db.select({ name: schema.clients.name }).from(schema.clients)
    .where(and(eq(schema.clients.id, v.clientId), eq(schema.clients.organisationId, organisationId)));
  const clientName = client?.name ?? "A client";

  const item = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.contentItems).values({
      organisationId,
      clientId: v.clientId,
      channel: v.channel,
      kind: KIND_FOR_CHANNEL[v.channel],
      status: "draft",
      periodKey: periodKeyFor(new Date()),
      title: excerpt(v.text, 60),
      body: v.text,
      linkUrl: v.linkUrl ?? null,
      source: "client",
      suggestedByUserId: v.actorUserId,
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: "client", actorId: v.actorUserId, action: "content_item.suggested",
      targetType: "content_item", targetId: row!.id, after: row,
    });
    await recordActivity(tx, organisationId, {
      clientId: v.clientId, actorKind: "client", actorId: v.actorUserId, kind: "content_item.suggested",
      title: `Post suggested for ${CHANNEL_LABEL[v.channel]}`,
      body: excerpt(v.text, 200),
      link: `/content/${row!.id}`,
    });
    return row!;
  });

  await notifyOwner(db, organisationId, {
    kind: "content_item.suggested",
    title: `${clientName} suggested a post`,
    body: excerpt(v.text, 200),
    link: `/content/${item.id}`,
  });

  return item;
}
