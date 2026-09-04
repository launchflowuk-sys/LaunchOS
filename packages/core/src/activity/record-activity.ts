import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { assertOwned } from "../tenancy/assert-owned.js";

export const RecordActivityInput = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  link: z.string().max(500).optional(),
});
export type RecordActivityInput = z.input<typeof RecordActivityInput>;

/**
 * Appends one entry to the client timeline. Safe to call inside a transaction
 * (pass the tx as `db`) so the narrative commits with the change it describes.
 */
export async function recordActivity(db: Db, organisationId: string, input: RecordActivityInput) {
  const v = RecordActivityInput.parse(input);
  if (v.clientId) await assertOwned(db, organisationId, schema.clients, v.clientId);
  if (v.siteId) await assertOwned(db, organisationId, schema.sites, v.siteId);
  const [row] = await db
    .insert(schema.activityEvents)
    .values({
      organisationId,
      clientId: v.clientId ?? null,
      siteId: v.siteId ?? null,
      actorKind: v.actorKind,
      actorId: v.actorId ?? null,
      kind: v.kind,
      title: v.title,
      body: v.body ?? null,
      link: v.link ?? null,
    })
    .returning();
  return row!;
}
