import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const CreateMonitorInput = z.object({
  siteId: z.string().uuid(),
  target: z.string().url(),
  intervalSeconds: z.number().int().min(30).default(60),
});
export type CreateMonitorInput = z.input<typeof CreateMonitorInput>;

export async function createMonitor(db: Db, organisationId: string, input: CreateMonitorInput) {
  const v = CreateMonitorInput.parse(input);
  const [monitor] = await db.insert(schema.monitors).values({ organisationId, ...v }).returning();
  await recordAudit(db, organisationId, { actorKind: "system", action: "monitor.created", targetType: "monitor", targetId: monitor!.id, after: monitor });
  return monitor!;
}
