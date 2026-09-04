import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const CreateAdAccountInput = z.object({
  clientId: z.string().uuid(),
  platform: z.enum(["google", "meta"]),
  externalId: z.string().min(1),
  name: z.string().min(1),
  currency: z.string().length(3).default("GBP"),
  status: z.enum(["active", "paused", "disconnected"]).default("active"),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateAdAccountInput = z.input<typeof CreateAdAccountInput>;

export async function createAdAccount(db: Db, organisationId: string, input: CreateAdAccountInput) {
  const v = CreateAdAccountInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  const [account] = await db.insert(schema.adAccounts).values({
    organisationId,
    clientId: v.clientId,
    platform: v.platform,
    externalId: v.externalId,
    name: v.name,
    currency: v.currency,
    status: v.status,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "ad_account.created",
    targetType: "ad_account", targetId: account!.id, after: account,
  });
  await recordActivity(db, organisationId, {
    clientId: v.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "ad_account.created",
    title: `${v.platform === "google" ? "Google" : "Meta"} ads account connected: ${v.name}`,
    link: `/ads/${account!.id}`,
  });
  return account!;
}

export interface AdAccountRow {
  id: string;
  clientId: string;
  clientName: string;
  platform: "google" | "meta";
  externalId: string;
  name: string;
  currency: string;
  status: "active" | "paused" | "disconnected";
}

export async function listAdAccounts(
  db: Db,
  organisationId: string,
  filter: { clientId?: string; status?: "active" | "paused" | "disconnected" } = {},
): Promise<AdAccountRow[]> {
  const where = [
    eq(schema.adAccounts.organisationId, organisationId),
    isNull(schema.adAccounts.deletedAt),
    ...(filter.clientId ? [eq(schema.adAccounts.clientId, filter.clientId)] : []),
    ...(filter.status ? [eq(schema.adAccounts.status, filter.status)] : []),
  ];
  return db.select({
    id: schema.adAccounts.id,
    clientId: schema.adAccounts.clientId,
    clientName: schema.clients.name,
    platform: schema.adAccounts.platform,
    externalId: schema.adAccounts.externalId,
    name: schema.adAccounts.name,
    currency: schema.adAccounts.currency,
    status: schema.adAccounts.status,
  })
    .from(schema.adAccounts)
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(and(...where))
    .orderBy(schema.clients.name, schema.adAccounts.name);
}
