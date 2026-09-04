import { getClient } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { ClientTabs } from "../tabs";

export const dynamic = "force-dynamic";

/** Everything else is work still in flight. */
const FINISHED: ("resolved" | "closed")[] = ["resolved", "closed"];

const RECENT_CONVERSATIONS = 5;

export default async function ClientSupportPage({ params }: PageProps<"/clients/[id]/support">) {
  const session = await requireAdmin();
  const { id } = await params;
  const db = getDb();

  // `getClient` is the org-scoped read `assertOwned` would perform, and it also
  // yields the name the header needs: a client of another organisation is a
  // 404 here rather than an error page.
  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const [identity, tickets, conversations] = await Promise.all([
    db
      .select({
        address: schema.emailIdentities.address,
        displayName: schema.emailIdentities.displayName,
        createdAt: schema.emailIdentities.createdAt,
      })
      .from(schema.emailIdentities)
      .where(
        and(
          eq(schema.emailIdentities.organisationId, session.organisationId),
          eq(schema.emailIdentities.clientId, id),
        ),
      )
      .limit(1),
    db
      .select({
        id: schema.tickets.id,
        subject: schema.tickets.subject,
        severity: schema.tickets.severity,
        status: schema.tickets.status,
        slaDueAt: schema.tickets.slaDueAt,
        assigneeName: schema.user.name,
      })
      .from(schema.tickets)
      .leftJoin(schema.user, eq(schema.tickets.assignedUserId, schema.user.id))
      .where(
        and(
          eq(schema.tickets.organisationId, session.organisationId),
          eq(schema.tickets.clientId, id),
          notInArray(schema.tickets.status, FINISHED),
        ),
      )
      .orderBy(desc(schema.tickets.createdAt)),
    db
      .select({
        id: schema.conversations.id,
        subject: schema.conversations.subject,
        channel: schema.conversations.channel,
        status: schema.conversations.status,
        lastMessageAt: schema.conversations.lastMessageAt,
      })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.organisationId, session.organisationId),
          eq(schema.conversations.clientId, id),
        ),
      )
      // A conversation with no message yet sorts last rather than first, which
      // is what plain `desc` would do in Postgres (DESC implies NULLS FIRST).
      .orderBy(sql`${schema.conversations.lastMessageAt} desc nulls last`)
      .limit(RECENT_CONVERSATIONS),
  ]);

  const address = identity[0];

  return (
    <>
      <PageHeader title={client.name} description="Where this client's email lands, and what is still open." />

      <ClientTabs clientId={client.id} active="support" />

      <div className="space-y-8">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-neutral-900">Support address</h2>
          {address ? (
            <div className="rounded-lg border border-neutral-200 bg-white p-4">
              <p className="font-mono text-sm text-neutral-900">{address.address}</p>
              <p className="mt-1 text-sm text-neutral-500">
                {address.displayName ?? client.name} · created {formatDateTime(address.createdAt)}
              </p>
              <p className="mt-2 text-xs text-neutral-400">
                Mail to this address is turned into a conversation and a ticket by the inbound webhook.
              </p>
            </div>
          ) : (
            <EmptyState>
              No support address yet. It is created automatically for new clients; run <code>pnpm db:seed</code> to
              backfill this one.
            </EmptyState>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-neutral-900">Open cases</h2>
          {tickets.length === 0 ? (
            <EmptyState>Nothing open. Resolved and closed cases stay on the case list.</EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Case</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>SLA due</TableHead>
                    <TableHead>Assignee</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tickets.map((ticket) => (
                    <TableRow key={ticket.id}>
                      <TableCell>
                        <Link href={`/cases/${ticket.id}`} className="font-medium text-neutral-900 hover:underline">
                          {ticket.subject}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={ticket.severity} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={ticket.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-neutral-600">
                        {formatDateTime(ticket.slaDueAt)}
                      </TableCell>
                      <TableCell className="text-neutral-600">{ticket.assigneeName ?? "Unassigned"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-neutral-900">Recent conversations</h2>
          {conversations.length === 0 ? (
            <EmptyState>No conversations yet. One is opened by the first email or portal message.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {conversations.map((conversation) => (
                <li key={conversation.id} className="rounded-lg border border-neutral-200 bg-white p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link href={`/inbox/${conversation.id}`} className="text-sm font-medium text-neutral-900 hover:underline">
                      {conversation.subject}
                    </Link>
                    <p className="text-xs text-neutral-400">
                      {conversation.channel} · {formatDateTime(conversation.lastMessageAt)}
                    </p>
                  </div>
                  <div className="mt-2">
                    <StatusBadge value={conversation.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
