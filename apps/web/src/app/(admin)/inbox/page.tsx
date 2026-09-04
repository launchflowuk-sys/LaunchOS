import { schema } from "@launchos/db";
import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const session = await requireAdmin();

  // The newest message's direction comes from a correlated subquery rather
  // than a join plus group by: one row per conversation, and "unread" stays a
  // property of the thread's last message rather than of a counter we would
  // have to keep in step by hand.
  const rows = await getDb()
    .select({
      id: schema.conversations.id,
      subject: schema.conversations.subject,
      status: schema.conversations.status,
      channel: schema.conversations.channel,
      participantEmail: schema.conversations.participantEmail,
      lastMessageAt: schema.conversations.lastMessageAt,
      ticketId: schema.conversations.ticketId,
      clientName: schema.clients.name,
      lastDirection: sql<string | null>`(
        select m.direction from messages m
        where m.conversation_id = ${schema.conversations.id}
        order by m.created_at desc limit 1
      )`,
    })
    .from(schema.conversations)
    .innerJoin(schema.clients, eq(schema.conversations.clientId, schema.clients.id))
    .where(eq(schema.conversations.organisationId, session.organisationId))
    .orderBy(desc(schema.conversations.lastMessageAt));

  return (
    <>
      <PageHeader title="Inbox" description="Every client conversation, newest first." />

      {rows.length === 0 ? (
        <EmptyState>No conversations yet. Mail sent to a client&apos;s support address appears here.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Last message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                // The last word on the thread is theirs, so it is still ours to answer.
                const needsReply = row.lastDirection === "inbound";
                return (
                  <TableRow key={row.id}>
                    <TableCell className={needsReply ? "font-semibold text-neutral-900" : "text-neutral-900"}>
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/inbox/${row.id}`} className="underline-offset-2 hover:underline">
                          {row.subject}
                        </Link>
                        {needsReply ? <StatusBadge value="needs reply" tone="warn" /> : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-neutral-600">{row.clientName}</TableCell>
                    <TableCell className="text-neutral-600">{row.participantEmail ?? "—"}</TableCell>
                    <TableCell className="text-neutral-600">{row.channel}</TableCell>
                    <TableCell className="whitespace-nowrap text-neutral-600">
                      {formatDateTime(row.lastMessageAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
