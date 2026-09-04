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
    // Postgres `now()` (hence `defaultNow()`) is fixed for the life of a
    // transaction, so two events recorded in the same transaction (a common
    // case: create-client and create-site both log activity inside their own
    // write transaction) can share an identical `createdAt`. `id` breaks the
    // tie so the order is reproducible, not merely "usually right".
    .orderBy(desc(schema.activityEvents.createdAt), desc(schema.activityEvents.id))
    .limit(v.limit);
}
