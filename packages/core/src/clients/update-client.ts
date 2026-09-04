import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";

const ACTOR = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

export const UpdateClientInput = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  tradingName: z.string().max(200).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(40).nullish(),
  addressLine1: z.string().max(200).nullish(),
  addressLine2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(),
  postcode: z.string().max(20).nullish(),
  country: z.string().length(2).optional(),
  websiteUrl: z.string().url().nullish(),
  industry: z.string().max(100).nullish(),
  notes: z.string().max(4000).nullish(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  ...ACTOR,
});
export type UpdateClientInput = z.input<typeof UpdateClientInput>;

/** `slug` and `supportEmail` are deliberately not patchable: mail already routes to them. */
export async function updateClient(db: Db, organisationId: string, input: UpdateClientInput) {
  const { clientId, actorKind, actorId, ...patch } = UpdateClientInput.parse(input);
  const where = and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.clients).where(where);
    if (!before) throw new Error(`client ${clientId} not found in organisation`);
    const [after] = await tx.update(schema.clients).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "client.updated", targetType: "client", targetId: clientId, before, after,
    });
    return after!;
  });
}

export const ArchiveClientInput = z.object({ clientId: z.string().uuid(), ...ACTOR });
export type ArchiveClientInput = z.input<typeof ArchiveClientInput>;

export async function archiveClient(db: Db, organisationId: string, input: ArchiveClientInput) {
  const v = ArchiveClientInput.parse(input);
  const client = await updateClient(db, organisationId, {
    clientId: v.clientId, status: "archived", actorKind: v.actorKind, actorId: v.actorId,
  });
  await recordActivity(db, organisationId, {
    clientId: client.id, actorKind: v.actorKind, actorId: v.actorId,
    kind: "client.archived", title: `Client archived: ${client.name}`, link: `/clients/${client.id}`,
  });
  return client;
}
