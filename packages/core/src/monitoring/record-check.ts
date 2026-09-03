import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

export const FAILURE_THRESHOLD = 3;

export const RecordCheckInput = z.object({
  monitorId: z.string().uuid(),
  ok: z.boolean(),
  statusCode: z.number().int().optional(),
  latencyMs: z.number().int().optional(),
  error: z.string().optional(),
});
export type RecordCheckInput = z.infer<typeof RecordCheckInput>;

export async function recordCheck(db: Db, organisationId: string, input: RecordCheckInput) {
  const v = RecordCheckInput.parse(input);
  const [check] = await db.insert(schema.uptimeChecks).values({ organisationId, ...v }).returning();

  const [before] = await db.select({ failures: schema.monitors.consecutiveFailures }).from(schema.monitors)
    .where(and(eq(schema.monitors.id, v.monitorId), eq(schema.monitors.organisationId, organisationId)));
  if (!before) throw new Error(`monitor ${v.monitorId} not found in organisation`);

  const [after] = await db.update(schema.monitors)
    .set({ consecutiveFailures: v.ok ? 0 : sql`${schema.monitors.consecutiveFailures} + 1`, updatedAt: new Date() })
    .where(and(eq(schema.monitors.id, v.monitorId), eq(schema.monitors.organisationId, organisationId)))
    .returning({ failures: schema.monitors.consecutiveFailures });

  const consecutiveFailures = after!.failures;
  return {
    check: check!,
    consecutiveFailures,
    shouldOpenIncident: !v.ok && consecutiveFailures === FAILURE_THRESHOLD,
    shouldResolveIncident: v.ok && before.failures >= FAILURE_THRESHOLD,
  };
}
