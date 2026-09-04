import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const UpsertBillingProfileInput = z.object({
  clientId: z.string().uuid(),
  billingName: z.string().max(200).nullish(),
  addressLine1: z.string().max(200).nullish(),
  addressLine2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(),
  postcode: z.string().max(20).nullish(),
  country: z.string().length(2).optional(),
  vatNumber: z.string().max(40).nullish(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  stripeCustomerId: z.string().max(100).nullish(),
  preferredMethod: z.string().max(100).nullish(),
  notes: z.string().max(4000).nullish(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type UpsertBillingProfileInput = z.input<typeof UpsertBillingProfileInput>;

/**
 * Patch semantics: only the keys present are written, so a form that edits the
 * address never clears the VAT number. Card and bank numbers are not accepted
 * by this schema and must never be added to it.
 */
export async function upsertBillingProfile(db: Db, organisationId: string, input: UpsertBillingProfileInput) {
  const { clientId, actorKind, actorId, ...patch } = UpsertBillingProfileInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, clientId);
  const where = and(
    eq(schema.billingProfiles.organisationId, organisationId),
    eq(schema.billingProfiles.clientId, clientId),
  );

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.billingProfiles).where(where);
    const [after] = before
      ? await tx.update(schema.billingProfiles).set({ ...patch, updatedAt: new Date() }).where(where).returning()
      : await tx.insert(schema.billingProfiles).values({ organisationId, clientId, ...patch }).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "billing_profile.saved", targetType: "billing_profile", targetId: after!.id, before, after,
    });
    return after!;
  });
}

export async function getBillingProfile(db: Db, organisationId: string, clientId: string) {
  const [row] = await db
    .select()
    .from(schema.billingProfiles)
    .where(and(eq(schema.billingProfiles.organisationId, organisationId), eq(schema.billingProfiles.clientId, clientId)));
  return row ?? null;
}
