import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

export const ListActivityInput = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListActivityInput = z.input<typeof ListActivityInput>;

export async function listActivity(db: Db, organisationId: string, input: ListActivityInput = {}) {
  const v = ListActivityInput.parse(input);
  return db
    .select()
    .from(schema.activityEvents)
    .where(
      and(
        eq(schema.activityEvents.organisationId, organisationId),
        v.clientId ? eq(schema.activityEvents.clientId, v.clientId) : undefined,
        v.siteId ? eq(schema.activityEvents.siteId, v.siteId) : undefined,
      ),
    )
    .orderBy(desc(schema.activityEvents.createdAt))
    .limit(v.limit);
}
