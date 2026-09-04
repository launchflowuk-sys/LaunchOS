import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { assertOwned } from "../tenancy/assert-owned.js";

export const CommentOnTaskInput = z.object({
  taskId: z.string().uuid(),
  bodyMd: z.string().min(1).max(10000),
  authorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  authorId: z.string().optional(),
});
export type CommentOnTaskInput = z.input<typeof CommentOnTaskInput>;

/**
 * Comments are append-only conversation, not business record mutation, so they
 * carry no audit row — the comment itself is the record.
 */
export async function commentOnTask(db: Db, organisationId: string, input: CommentOnTaskInput) {
  const v = CommentOnTaskInput.parse(input);
  await assertOwned(db, organisationId, schema.tasks, v.taskId);
  const [comment] = await db.insert(schema.taskComments).values({
    organisationId, taskId: v.taskId, authorKind: v.authorKind, authorId: v.authorId ?? null, bodyMd: v.bodyMd,
  }).returning();
  return comment!;
}
