import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { supportEmailFor } from "../config.js";
import { emit } from "../events/emit.js";
import { uniqueClientSlug } from "./slug.js";

export const CreateClientInput = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().max(48).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
  tradingName: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  postcode: z.string().max(20).optional(),
  country: z.string().length(2).default("GB"),
  websiteUrl: z.string().url().optional(),
  industry: z.string().max(100).optional(),
  notes: z.string().max(4000).optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateClientInput = z.input<typeof CreateClientInput>;

/**
 * Creates the client, its (empty) billing profile and the first timeline entry
 * in one transaction, then emits `client.created` so Plan 3's task engine can
 * generate the onboarding list. `support_email` is stored as a string here;
 * Plan 4 adds the routable `email_identities` row for the same address.
 */
export async function createClient(db: Db, organisationId: string, input: CreateClientInput) {
  const { actorKind, actorId, slug: desiredSlug, ...fields } = CreateClientInput.parse(input);
  const slug = await uniqueClientSlug(db, organisationId, desiredSlug ?? fields.name);
  const supportEmail = supportEmailFor(slug);

  const client = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [row] = await tx.insert(schema.clients).values({ organisationId, ...fields, slug, supportEmail }).returning();
    await tx.insert(schema.billingProfiles).values({
      organisationId,
      clientId: row!.id,
      billingName: fields.tradingName ?? fields.name,
      addressLine1: fields.addressLine1 ?? null,
      addressLine2: fields.addressLine2 ?? null,
      city: fields.city ?? null,
      postcode: fields.postcode ?? null,
      country: fields.country,
    });
    await recordActivity(inner, organisationId, {
      clientId: row!.id,
      actorKind,
      actorId,
      kind: "client.created",
      title: `Client created: ${row!.name}`,
      body: `Support address ${supportEmail}`,
      link: `/clients/${row!.id}`,
    });
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "client.created", targetType: "client", targetId: row!.id, after: row,
    });
    return row!;
  });

  // After commit: a subscriber must never see an id the transaction rolled back.
  await emit({ name: "client.created", organisationId, clientId: client.id });
  return client;
}
