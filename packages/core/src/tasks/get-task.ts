import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";

/** The task plus its comment thread, or null when it is not this org's task. */
export async function getTask(db: Db, organisationId: string, taskId: string) {
  const [task] = await db.select().from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.organisationId, organisationId)));
  if (!task) return null;
  const comments = await db.select().from(schema.taskComments)
    .where(and(eq(schema.taskComments.taskId, taskId), eq(schema.taskComments.organisationId, organisationId)))
    .orderBy(asc(schema.taskComments.createdAt));
  return { task, comments };
}
