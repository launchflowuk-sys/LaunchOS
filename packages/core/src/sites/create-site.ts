import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const CreateSiteInput = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(200),
  // `.url()` is `new URL()`, which happily accepts `javascript:` and `data:`.
  // The value is rendered as an href in both portals, so the scheme is pinned.
  primaryUrl: z
    .string()
    .url()
    .refine((u) => /^https?:$/.test(new URL(u).protocol), "primaryUrl must be an http(s) URL"),
  platform: z.enum(["wordpress", "static", "nextjs", "other"]).default("wordpress"),
  hostingProvider: z.enum(["coolify", "other"]).default("coolify"),
  hostingRef: z.string().max(200).optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateSiteInput = z.input<typeof CreateSiteInput>;

export async function createSite(db: Db, organisationId: string, input: CreateSiteInput) {
  const { actorKind, actorId, ...fields } = CreateSiteInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, fields.clientId);

  const site = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [row] = await tx.insert(schema.sites).values({ organisationId, ...fields }).returning();
    await recordActivity(inner, organisationId, {
      clientId: fields.clientId, siteId: row!.id, actorKind, actorId, kind: "site.created",
      title: `Website added: ${row!.name}`, body: row!.primaryUrl, link: `/websites/${row!.id}`,
    });
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "site.created", targetType: "site", targetId: row!.id, after: row,
    });
    return row!;
  });

  await emit({ name: "site.created", organisationId, siteId: site.id });
  return site;
}
