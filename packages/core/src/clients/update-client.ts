import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

type ActorKind = "user" | "client" | "agent" | "system";

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

/**
 * Applies the patch and records the audit entry inside the caller's
 * transaction. Shared by `updateClient` (which opens its own transaction) and
 * `archiveClient` (which also appends a timeline entry in that same
 * transaction, so the archive and its narrative commit or roll back together).
 */
async function applyClientUpdate(
  tx: Db,
  organisationId: string,
  clientId: string,
  patch: Record<string, unknown>,
  actorKind: ActorKind,
  actorId: string | undefined,
) {
  await assertOwned(tx, organisationId, schema.clients, clientId);
  const where = and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId));
  const [before] = await tx.select().from(schema.clients).where(where);
  const [after] = await tx.update(schema.clients).set({ ...patch, updatedAt: new Date() }).where(where).returning();
  await recordAudit(tx, organisationId, {
    actorKind, actorId, action: "client.updated", targetType: "client", targetId: clientId, before, after,
  });
  return after!;
}

/** `slug` and `supportEmail` are deliberately not patchable: mail already routes to them. */
export async function updateClient(db: Db, organisationId: string, input: UpdateClientInput) {
  const { clientId, actorKind, actorId, ...patch } = UpdateClientInput.parse(input);
  return db.transaction(async (tx) => applyClientUpdate(tx as unknown as Db, organisationId, clientId, patch, actorKind, actorId));
}

export const ArchiveClientInput = z.object({ clientId: z.string().uuid(), ...ACTOR });
export type ArchiveClientInput = z.input<typeof ArchiveClientInput>;

export async function archiveClient(db: Db, organisationId: string, input: ArchiveClientInput) {
  const v = ArchiveClientInput.parse(input);
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const client = await applyClientUpdate(inner, organisationId, v.clientId, { status: "archived" }, v.actorKind, v.actorId);
    await recordActivity(inner, organisationId, {
      clientId: client.id, actorKind: v.actorKind, actorId: v.actorId,
      kind: "client.archived", title: `Client archived: ${client.name}`, link: `/clients/${client.id}`,
    });
    return client;
  });
}
