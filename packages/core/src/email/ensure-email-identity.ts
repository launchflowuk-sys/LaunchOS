import { randomBytes } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { supportEmailDomain } from "../config.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const EnsureEmailIdentityInput = z.object({ clientId: z.string().uuid(), displayName: z.string().optional() });
export type EnsureEmailIdentityInput = z.input<typeof EnsureEmailIdentityInput>;

export function supportAddress(slug: string, domain: string): string {
  return `${slug}@${domain}`.toLowerCase();
}

/**
 * Idempotent: one identity per client, created from the `client.created`
 * handler and backfilled by the seed. The env is injectable so tests do not
 * depend on the developer's .env. The domain comes from `supportEmailDomain`,
 * the same helper `createClient` uses for `clients.support_email`, so the
 * routable identity and the stored string can never drift apart.
 */
export async function ensureEmailIdentity(
  db: Db,
  organisationId: string,
  input: EnsureEmailIdentityInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  const v = EnsureEmailIdentityInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);

  const [existing] = await db
    .select()
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, v.clientId)));
  if (existing) return existing;

  const domain = supportEmailDomain(env);
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, v.clientId));

  const [created] = await db
    .insert(schema.emailIdentities)
    .values({
      organisationId,
      clientId: v.clientId,
      address: supportAddress(client!.slug, domain),
      displayName: v.displayName ?? `${client!.name} Support`,
      inboundSecret: randomBytes(24).toString("hex"),
    })
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: "system", action: "email_identity.created", targetType: "email_identity", targetId: created!.id, after: created,
  });
  return created!;
}
