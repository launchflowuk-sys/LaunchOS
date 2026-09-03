import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const CreateClientInput = z.object({ name: z.string().min(1), email: z.string().email().optional(), phone: z.string().optional() });
export type CreateClientInput = z.infer<typeof CreateClientInput>;

export async function createClient(db: Db, organisationId: string, input: CreateClientInput) {
  const v = CreateClientInput.parse(input);
  const [client] = await db.insert(schema.clients).values({ organisationId, ...v }).returning();
  await recordAudit(db, organisationId, { actorKind: "system", action: "client.created", targetType: "client", targetId: client!.id, after: client });
  return client!;
}
