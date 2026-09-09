import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

/**
 * Deleting a client is not archiving it.
 *
 * `clients` is the parent of twenty-four cascading foreign keys, five of them
 * in billing. A delete takes the invoices, the payments and the subscriptions
 * with it and leaves nothing behind — no soft-deleted row, no audit of what
 * the numbers were, because the rows the audit would point at are gone too.
 *
 * A paid invoice is a financial record. In the UK it has to survive six years,
 * and it belongs to the business's own books rather than to the client it was
 * addressed to. So money is a **blocker**: the delete is refused and archiving
 * is offered instead. Work is a **warning**: it is listed, it will be
 * destroyed, and a person confirms it.
 *
 * This split is the whole point of the feature. A confirmation dialog that
 * lists everything equally teaches you to click through it.
 */

/** Something that makes deletion the wrong answer. Refused, not confirmed. */
export type DeletionBlocker = {
  kind: "paid_invoice" | "payment" | "active_subscription";
  count: number;
  detail: string;
};

/** Something that will be destroyed. Listed, then confirmed. */
export type DeletionWarning = { kind: string; count: number };

export type ClientDeletionReport = {
  clientId: string;
  clientName: string;
  blockers: DeletionBlocker[];
  warnings: DeletionWarning[];
  /** True when nothing financial stands in the way. */
  deletable: boolean;
};

/** Subscription statuses that still mean money is expected. */
const LIVE_SUBSCRIPTION = ["active", "past_due", "trialing"] as const;
/** Invoice statuses that mean money actually changed hands. */
const SETTLED_INVOICE = ["paid"] as const;

/** One count, one table, no generic gymnastics. */
async function n(rows: Promise<{ n: number }[]>): Promise<number> {
  return Number((await rows)[0]?.n ?? 0);
}

/**
 * What stands between this client and deletion.
 *
 * Read-only, and safe to call for a preview: the dialog shows exactly what the
 * delete will refuse or destroy, so nothing is a surprise afterwards.
 */
export async function clientDeletionReport(
  db: Db,
  organisationId: string,
  clientId: string,
): Promise<ClientDeletionReport> {
  const [client] = await db.select().from(schema.clients).where(and(
    eq(schema.clients.organisationId, organisationId),
    eq(schema.clients.id, clientId),
  ));
  if (!client) throw new Error(`client ${clientId} not found in organisation`);

  const [paidInvoices, payments, liveSubscriptions, sites, domains, tickets, tasks, projects] = await Promise.all([
    n(db.select({ n: count() }).from(schema.invoices).where(and(
      eq(schema.invoices.organisationId, organisationId),
      eq(schema.invoices.clientId, clientId),
      inArray(schema.invoices.status, [...SETTLED_INVOICE]),
    ))),
    n(db.select({ n: count() }).from(schema.payments).where(and(
      eq(schema.payments.organisationId, organisationId),
      eq(schema.payments.clientId, clientId),
    ))),
    n(db.select({ n: count() }).from(schema.subscriptions).where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      eq(schema.subscriptions.clientId, clientId),
      inArray(schema.subscriptions.status, [...LIVE_SUBSCRIPTION]),
      isNull(schema.subscriptions.deletedAt),
    ))),
    n(db.select({ n: count() }).from(schema.sites).where(and(
      eq(schema.sites.organisationId, organisationId), eq(schema.sites.clientId, clientId),
    ))),
    n(db.select({ n: count() }).from(schema.domains).where(and(
      eq(schema.domains.organisationId, organisationId), eq(schema.domains.clientId, clientId),
    ))),
    n(db.select({ n: count() }).from(schema.tickets).where(and(
      eq(schema.tickets.organisationId, organisationId), eq(schema.tickets.clientId, clientId),
    ))),
    n(db.select({ n: count() }).from(schema.tasks).where(and(
      eq(schema.tasks.organisationId, organisationId), eq(schema.tasks.clientId, clientId),
    ))),
    n(db.select({ n: count() }).from(schema.projects).where(and(
      eq(schema.projects.organisationId, organisationId), eq(schema.projects.clientId, clientId),
    ))),
  ]);

  const blockers: DeletionBlocker[] = [];
  if (paidInvoices > 0) {
    blockers.push({
      kind: "paid_invoice",
      count: paidInvoices,
      detail: `${paidInvoices} paid invoice${paidInvoices === 1 ? "" : "s"} — these are your own accounting records, not the client's`,
    });
  }
  if (payments > 0) {
    blockers.push({
      kind: "payment",
      count: payments,
      detail: `${payments} recorded payment${payments === 1 ? "" : "s"} — deleting these changes what the books say you were paid`,
    });
  }
  if (liveSubscriptions > 0) {
    blockers.push({
      kind: "active_subscription",
      count: liveSubscriptions,
      detail: `${liveSubscriptions} live subscription${liveSubscriptions === 1 ? "" : "s"} — cancel ${liveSubscriptions === 1 ? "it" : "them"} first, or the provider keeps charging a client this system no longer knows`,
    });
  }

  const warnings: DeletionWarning[] = [
    { kind: "websites", count: sites },
    { kind: "domains", count: domains },
    { kind: "support cases", count: tickets },
    { kind: "tasks", count: tasks },
    { kind: "projects", count: projects },
  ].filter((w) => w.count > 0);

  return { clientId, clientName: client.name, blockers, warnings, deletable: blockers.length === 0 };
}

export const DeleteClientInput = z.object({
  clientId: z.string().uuid(),
  /** The client's name, typed. Deleting cascades and cannot be undone. */
  confirmName: z.string().trim().min(1),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type DeleteClientInput = z.input<typeof DeleteClientInput>;

/**
 * Delete a client and everything cascading from it.
 *
 * Refuses while any blocker stands. The audit row is written *before* the
 * delete and holds the whole client record plus the report, because afterwards
 * there is nothing left to point at.
 */
export async function deleteClient(db: Db, organisationId: string, input: DeleteClientInput): Promise<void> {
  const v = DeleteClientInput.parse(input);
  const report = await clientDeletionReport(db, organisationId, v.clientId);

  if (v.confirmName.toLowerCase() !== report.clientName.toLowerCase()) {
    throw new Error(`Type ${report.clientName} exactly to delete it`);
  }
  if (!report.deletable) {
    throw new Error(
      `${report.clientName} cannot be deleted: ${report.blockers.map((b) => b.detail).join("; ")}. Archive the client instead — it disappears from your lists and keeps the records.`,
    );
  }

  await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.clients).where(and(
      eq(schema.clients.organisationId, organisationId),
      eq(schema.clients.id, v.clientId),
    ));
    if (!before) throw new Error(`client ${v.clientId} not found in organisation`);

    // Written first: once the row is gone the audit has nothing to reference,
    // so the record of what was destroyed has to exist before the destroying.
    await recordAudit(inner, organisationId, {
      actorKind: v.actorKind,
      actorId: v.actorId,
      action: "client.deleted",
      targetType: "client",
      targetId: v.clientId,
      before: { ...before, deletionReport: report },
    });

    await tx.delete(schema.clients).where(and(
      eq(schema.clients.organisationId, organisationId),
      eq(schema.clients.id, v.clientId),
    ));
  });
}

/** Clients that are archived, for a recovery screen. */
export async function listArchivedClients(db: Db, organisationId: string) {
  return db.select({
    id: schema.clients.id,
    name: schema.clients.name,
    slug: schema.clients.slug,
    email: schema.clients.email,
    updatedAt: schema.clients.updatedAt,
  }).from(schema.clients).where(and(
    eq(schema.clients.organisationId, organisationId),
    eq(schema.clients.status, "archived"),
    isNull(schema.clients.deletedAt),
  )).orderBy(schema.clients.name);
}

/** Put an archived client back. The counterpart to `archiveClient`. */
export const RestoreClientInput = z.object({
  clientId: z.string().uuid(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type RestoreClientInput = z.input<typeof RestoreClientInput>;

export async function restoreClient(db: Db, organisationId: string, input: RestoreClientInput) {
  const v = RestoreClientInput.parse(input);
  return db.transaction(async (tx) => {
    const where = and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.id, v.clientId));
    const [before] = await tx.select().from(schema.clients).where(where);
    if (!before) throw new Error(`client ${v.clientId} not found in organisation`);
    if (before.status !== "archived") return before;

    const [after] = await tx.update(schema.clients)
      .set({ status: "active", updatedAt: new Date() })
      .where(where)
      .returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId,
      action: "client.restored", targetType: "client", targetId: v.clientId, before, after,
    });
    return after!;
  });
}
