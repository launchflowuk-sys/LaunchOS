import { findOverdueInvoices } from "@launchos/core";
import type { Db } from "@launchos/db";

/** Flags every invoice past its due date, one billing ticket each. Runs at 07:30. */
export async function runOverdueSweep(db: Db, organisationId: string, options: { now: Date }) {
  const outcomes = await findOverdueInvoices(db, organisationId, { now: options.now });
  return { flagged: outcomes.length, invoiceNumbers: outcomes.map((o) => o.invoice.number) };
}
