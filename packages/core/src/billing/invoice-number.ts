import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { sql } from "drizzle-orm";

export const INVOICE_NUMBER_PREFIX = "LF";

/**
 * Allocates the next invoice number for an organisation and year.
 *
 * One upserting statement, so two concurrent invoices serialise on the
 * sequence row's lock instead of racing a read-modify-write and colliding on
 * the unique (organisation_id, number) index.
 */
export async function nextInvoiceNumber(db: Db, organisationId: string, year: number): Promise<string> {
  const [row] = await db
    .insert(schema.invoiceSequences)
    .values({ organisationId, year, nextNumber: 1 })
    .onConflictDoUpdate({
      target: [schema.invoiceSequences.organisationId, schema.invoiceSequences.year],
      set: { nextNumber: sql`${schema.invoiceSequences.nextNumber} + 1`, updatedAt: new Date() },
    })
    .returning({ nextNumber: schema.invoiceSequences.nextNumber });
  return `${INVOICE_NUMBER_PREFIX}-${year}-${String(row!.nextNumber).padStart(4, "0")}`;
}
