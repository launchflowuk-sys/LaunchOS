import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";

export const ListTaskTemplatesInput = z.object({
  phase: z.enum(schema.taskPhaseEnum.enumValues).optional(),
  packageId: z.string().uuid().optional(),
  /** true: also return templates with a null package_id (apply to everything). */
  includeGlobal: z.boolean().default(true),
});
export type ListTaskTemplatesInput = z.input<typeof ListTaskTemplatesInput>;

export async function listTaskTemplates(db: Db, organisationId: string, input: ListTaskTemplatesInput = {}) {
  const v = ListTaskTemplatesInput.parse(input);
  const where: SQL[] = [eq(schema.taskTemplates.organisationId, organisationId)];
  if (v.phase) where.push(eq(schema.taskTemplates.phase, v.phase));
  if (v.packageId) {
    where.push(
      v.includeGlobal
        ? or(isNull(schema.taskTemplates.packageId), eq(schema.taskTemplates.packageId, v.packageId))!
        : eq(schema.taskTemplates.packageId, v.packageId),
    );
  } else if (!v.includeGlobal) {
    where.push(isNull(schema.taskTemplates.packageId));
  }
  return db.select().from(schema.taskTemplates)
    .where(and(...where))
    .orderBy(asc(schema.taskTemplates.sortOrder), asc(schema.taskTemplates.createdAt));
}
