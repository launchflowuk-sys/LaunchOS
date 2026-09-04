import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { CountryField, PostcodeField, VatNumberField } from "./supplier-fields.js";

/**
 * The supplier identity printed on every invoice this organisation raises.
 *
 * `name`, `slug` and `status` are deliberately not patchable here: the slug is
 * the tenant key other rows and URLs are built from, and suspending an
 * organisation is an operator action, not a settings-screen one.
 *
 * Every field is `nullish` so an emptied input clears the column rather than
 * being ignored — a business that de-registers for VAT has to be able to take
 * its VAT number off its invoices.
 *
 * The three fields with legal weight — the VAT registration, the country it is
 * registered in and the postcode HMRC expects on the invoice — are checked for
 * shape, not just length: see `supplier-fields.ts`. `vatNumber` in particular
 * is what decides whether an invoice may charge VAT at all
 * (`billing/vat-rate.ts`), so junk in it silently switches the VAT line on.
 */
export const UpdateOrganisationInput = z.object({
  legalName: z.string().trim().max(200).nullish(),
  addressLine1: z.string().trim().max(200).nullish(),
  addressLine2: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(100).nullish(),
  postcode: PostcodeField,
  country: CountryField,
  vatNumber: VatNumberField,
  companyNumber: z.string().trim().max(40).nullish(),
  invoiceFooter: z.string().trim().max(1000).nullish(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type UpdateOrganisationInput = z.input<typeof UpdateOrganisationInput>;

/**
 * Patches the organisation's supplier details and audits the change in the
 * same transaction, so a crash between the write and its audit row can never
 * leave one without the other.
 *
 * `organisationId` is the tenant scope *and* the target: there is no
 * `assertOwned` to make, because an organisation cannot be owned by another
 * organisation. The WHERE clause is still written out rather than assumed —
 * an id that does not exist updates nothing and throws rather than silently
 * reporting success.
 */
export async function updateOrganisation(db: Db, organisationId: string, input: UpdateOrganisationInput) {
  const { actorKind, actorId, ...patch } = UpdateOrganisationInput.parse(input);

  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const where = eq(schema.organisations.id, organisationId);

    const [before] = await tx.select().from(schema.organisations).where(where);
    if (!before) throw new Error(`organisation ${organisationId} not found`);

    const [after] = await tx
      .update(schema.organisations)
      .set({ ...patch, updatedAt: new Date() })
      .where(where)
      .returning();

    await recordAudit(tx, organisationId, {
      actorKind,
      actorId,
      action: "organisation.updated",
      targetType: "organisation",
      targetId: organisationId,
      before,
      after,
    });
    return after!;
  });
}
