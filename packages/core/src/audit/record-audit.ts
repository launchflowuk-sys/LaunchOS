import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";

export const RecordAuditInput = z.object({
  actorKind: z.enum(["user", "client", "agent", "system"]),
  actorId: z.string().optional(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type RecordAuditInput = z.infer<typeof RecordAuditInput>;

export async function recordAudit(db: Db, organisationId: string, input: RecordAuditInput) {
  const v = RecordAuditInput.parse(input);
  const [row] = await db.insert(schema.auditLog).values({ organisationId, ...v }).returning();
  return row!;
}
