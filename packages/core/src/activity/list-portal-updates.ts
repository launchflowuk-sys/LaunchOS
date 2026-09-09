import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, ne } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

/**
 * What the client's bell shows.
 *
 * Deliberately **not** a read of `activity_events`. That table is the internal
 * timeline — it carries a row for every draft invoice, every agent step and
 * every note we write about a client — and filtering it by `client_id` would
 * hand all of that to the client it is about. There is no `client_visible`
 * column on it to lean on, and adding an allowlist of kinds would put the
 * whole disclosure boundary on somebody remembering to update a list every
 * time a feature lands.
 *
 * So this reads the four things the portal already shows, each through the
 * same filter its own screen uses. The bell can then only ever surface
 * something the client could have reached by clicking, which is the rule, and
 * it stays true without maintenance.
 */

export const ListPortalUpdatesInput = z.object({
  /** Anything newer than this counts as unseen. Absent means "everything is old". */
  since: z.date().optional(),
  limit: z.number().int().min(1).max(50).default(12),
});
export type ListPortalUpdatesInput = z.input<typeof ListPortalUpdatesInput>;

export interface PortalUpdate {
  id: string;
  /** `<domain>.<event>`, so tone and icon derive the same way notifications do. */
  kind: string;
  title: string;
  body: string | null;
  link: string;
  at: Date;
  unseen: boolean;
}

export interface PortalUpdates {
  rows: PortalUpdate[];
  /** How many of them the client has not looked at yet. */
  unseen: number;
}

export async function listPortalUpdates(
  db: Db,
  organisationId: string,
  clientId: string,
  input: ListPortalUpdatesInput = {},
): Promise<PortalUpdates> {
  const v = ListPortalUpdatesInput.parse(input);
  /** Both scopes at once, so no query below can filter by one and forget the other. */
  const owned = (table: { organisationId: PgColumn; clientId: PgColumn }) =>
    and(eq(table.organisationId, organisationId), eq(table.clientId, clientId));

  const [requests, invoices, documents, tasks] = await Promise.all([
    db
      .select({
        id: schema.tickets.id,
        subject: schema.tickets.subject,
        status: schema.tickets.status,
        updatedAt: schema.tickets.updatedAt,
        lastMessageAt: schema.conversations.lastMessageAt,
      })
      .from(schema.tickets)
      .leftJoin(schema.conversations, eq(schema.tickets.conversationId, schema.conversations.id))
      // The same clause the portal's own support screen uses: the overdue
      // sweep opens a ticket per unpaid invoice and an agent's
      // `tickets_create` is internal by design.
      .where(and(owned(schema.tickets), eq(schema.tickets.clientVisible, true)))
      .orderBy(desc(schema.tickets.updatedAt))
      .limit(v.limit),
    db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        status: schema.invoices.status,
        issuedAt: schema.invoices.issuedAt,
        createdAt: schema.invoices.createdAt,
      })
      .from(schema.invoices)
      .where(and(owned(schema.invoices), ne(schema.invoices.status, "draft")))
      .orderBy(desc(schema.invoices.createdAt))
      .limit(v.limit),
    db
      .select({
        id: schema.documents.id,
        title: schema.documents.title,
        reference: schema.documents.reference,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .where(owned(schema.documents))
      .orderBy(desc(schema.documents.createdAt))
      .limit(v.limit),
    db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        status: schema.tasks.status,
        updatedAt: schema.tasks.updatedAt,
      })
      .from(schema.tasks)
      .where(and(owned(schema.tasks), eq(schema.tasks.clientVisible, true)))
      .orderBy(desc(schema.tasks.updatedAt))
      .limit(v.limit),
  ]);

  const rows: PortalUpdate[] = [
    ...requests.map((row) => ({
      id: `ticket:${row.id}`,
      kind: "ticket.replied",
      title: row.subject,
      body: "Your request",
      link: `/portal/support/${row.id}`,
      at: row.lastMessageAt ?? row.updatedAt,
    })),
    ...invoices.map((row) => ({
      id: `invoice:${row.id}`,
      // Overdue reads red through the shared tone derivation, which is the one
      // thing on this list a client genuinely needs to act on.
      kind: row.status === "overdue" ? "invoice.overdue" : "invoice.issued",
      title: `Invoice ${row.number}`,
      body: row.status === "overdue" ? "Overdue" : null,
      link: `/portal/invoices/${row.id}`,
      at: row.issuedAt ?? row.createdAt,
    })),
    ...documents.map((row) => ({
      id: `document:${row.id}`,
      kind: "document.added",
      title: row.title,
      body: row.reference,
      link: "/portal/documents",
      at: row.createdAt,
    })),
    ...tasks.map((row) => ({
      id: `task:${row.id}`,
      kind: row.status === "done" ? "task.completed" : "task.updated",
      title: row.title,
      body: "Work on your account",
      link: "/portal/tasks",
      at: row.updatedAt,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, v.limit)
    .map((row) => ({ ...row, unseen: v.since ? row.at > v.since : false }));

  return { rows, unseen: rows.filter((row) => row.unseen).length };
}

/**
 * Stamps "the client has now looked". Called when the bell is opened, not on
 * every page load: a badge that cleared itself because somebody happened to
 * land on the portal would be worse than no badge.
 */
export async function markPortalSeen(
  db: Db,
  organisationId: string,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(schema.clientUsers)
    .set({ portalSeenAt: now })
    .where(and(eq(schema.clientUsers.organisationId, organisationId), eq(schema.clientUsers.userId, userId)));
}

/** The timestamp the badge counts against, or null for somebody who has never opened it. */
export async function portalSeenAt(db: Db, organisationId: string, userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ seenAt: schema.clientUsers.portalSeenAt })
    .from(schema.clientUsers)
    .where(and(eq(schema.clientUsers.organisationId, organisationId), eq(schema.clientUsers.userId, userId)));
  return row?.seenAt ?? null;
}
