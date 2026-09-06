import { ensureInvoiceDocument, type InvoiceDocumentDeps } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { sweep, throwOnSweepFailure, type SweepLogger } from "./sweep.js";

/**
 * Every invoice gets its PDF, and the worker is where it is drawn.
 *
 * `sendApprovedInvoice` takes an optional renderer and **the web deliberately
 * passes none**: `playwright` is a dependency of `apps/worker` and not of
 * `apps/web`, so a Server Action that reached for Chromium would work on a
 * laptop and fail on Coolify. Without a renderer that send only *links* a
 * document the invoice already has — so something has to have drawn it first,
 * and this is that something.
 *
 * A sweep rather than an event, because there is no `invoice.created` event to
 * hang it on and inventing one would put a domain event in the schema for a
 * single consumer. Two minutes is the clock: an invoice is raised, a
 * `message_send` card goes into the queue, and Shoji reads it before he
 * approves it — the render happens in that gap. If it does not, nothing
 * breaks; the send goes out without a PDF link and the next tick files the
 * document against the invoice, where the portal and the admin page read it
 * from anyway.
 *
 * `ensureInvoiceDocument` is idempotent through `invoices.document_id`, so a
 * retried tick renders nothing twice, and an invoice is a financial record —
 * its PDF must not change between two people looking at it.
 */

/** Every two minutes, Europe/London — the gap between raising an invoice and approving its send. */
export const INVOICE_DOCUMENTS_CRON = "*/2 * * * *";

/**
 * How many PDFs one tick will draw for one organisation.
 *
 * The first tick after this ships has every invoice ever raised to catch up
 * on, and a browser drawing an unbounded backlog is a worker that stops doing
 * anything else. Twenty-five a tick clears a year of monthly invoicing in
 * under a minute of ticks and is invisible thereafter, when the answer is
 * almost always zero.
 */
export const INVOICE_DOCUMENT_BATCH = 25;

export interface InvoiceDocumentsLogger extends SweepLogger {
  info(...args: unknown[]): void;
}

export interface InvoiceDocumentsOptions {
  /** Defaults to `renderPdf` inside `ensureInvoiceDocument`; a test passes a stub. */
  render?: InvoiceDocumentDeps["render"];
  limit?: number;
  logger?: InvoiceDocumentsLogger;
  env?: NodeJS.ProcessEnv;
}

export interface InvoiceDocumentsResult {
  /** Invoices found without a PDF this tick, up to the batch size. */
  pending: number;
  rendered: number;
  failed: number;
}

/**
 * Invoices with no PDF yet.
 *
 * `void` is excluded and nothing else is: a cancelled invoice is paper nobody
 * should be handed, while a draft, a sent, an overdue and a paid one all
 * belong in the client's filing cabinet. Newest first, so the invoice somebody
 * is waiting to send is the one drawn first.
 */
async function invoicesWithoutDocuments(db: Db, organisationId: string, limit: number) {
  return db.select({ id: schema.invoices.id, number: schema.invoices.number })
    .from(schema.invoices)
    .where(and(
      eq(schema.invoices.organisationId, organisationId),
      isNull(schema.invoices.documentId),
      isNull(schema.invoices.deletedAt),
      ne(schema.invoices.status, "void"),
    ))
    .orderBy(desc(schema.invoices.issuedAt))
    .limit(limit);
}

/** Draws and files the missing PDFs for one organisation. */
export async function runInvoiceDocuments(
  db: Db,
  organisationId: string,
  options: InvoiceDocumentsOptions = {},
): Promise<InvoiceDocumentsResult> {
  const logger = options.logger ?? console;
  const deps: InvoiceDocumentDeps = { render: options.render };
  const env = options.env ?? process.env;
  const pending = await invoicesWithoutDocuments(db, organisationId, options.limit ?? INVOICE_DOCUMENT_BATCH);
  if (pending.length === 0) return { pending: 0, rendered: 0, failed: 0 };

  let rendered = 0;
  const label = `invoice documents (${organisationId})`;
  const summary = await sweep(pending, { label, id: (invoice) => invoice.id, logger }, async (invoice) => {
    await ensureInvoiceDocument(db, organisationId, { invoiceId: invoice.id, actorKind: "system" }, deps, env);
    rendered += 1;
  });

  const result: InvoiceDocumentsResult = { pending: pending.length, rendered, failed: summary.failed };
  logger.info({ organisationId, ...result }, "invoice documents");
  // One invoice whose render throws must not cost the rest of the batch theirs;
  // the job still fails so pg-boss retries, and the retry redraws only what is
  // still missing.
  throwOnSweepFailure(label, summary);
  return result;
}
