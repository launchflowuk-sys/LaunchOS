import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager, pageParam } from "@/components/pager";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { lastMessageDirection } from "./thread-filters";

export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const session = await requireAdmin();
  const page = pageParam((await searchParams).page);

  // The newest message's direction comes from a correlated subquery rather
  // than a join plus group by: one row per conversation, and "unread" stays a
  // property of the thread's last message rather than of a counter we would
  // have to keep in step by hand. The subquery is per returned row, which is
  // why the page is bounded: a year of support mail must not turn one screen
  // into thousands of index lookups.
  const found = await getDb()
    .select({
      id: schema.conversations.id,
      subject: schema.conversations.subject,
      status: schema.conversations.status,
      channel: schema.conversations.channel,
      participantEmail: schema.conversations.participantEmail,
      lastMessageAt: schema.conversations.lastMessageAt,
      ticketId: schema.conversations.ticketId,
      clientName: schema.clients.name,
      // The courtesy nudge is `outbound` and always the newest row on a
      // portal thread, so counting it would answer "who spoke last" with a
      // machine rather than with either party. See `thread-filters.ts`.
      lastDirection: lastMessageDirection(),
    })
    .from(schema.conversations)
    .innerJoin(schema.clients, eq(schema.conversations.clientId, schema.clients.id))
    .where(eq(schema.conversations.organisationId, session.organisationId))
    .orderBy(desc(schema.conversations.lastMessageAt))
    // One extra row is the whole "is there a next page" answer, without a count.
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE);

  const hasNext = found.length > PAGE_SIZE;
  const rows = hasNext ? found.slice(0, PAGE_SIZE) : found;

  return (
    <>
      <PageHeader title="Inbox" description="Every client conversation, newest first." />

      {rows.length === 0 ? (
        <EmptyState>
          {page > 1
            ? "No more conversations on this page."
            : "No conversations yet. Mail sent to a client's support address appears here."}
        </EmptyState>
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

      <Pager basePath="/inbox" query={{}} page={page} hasNext={hasNext} />
    </>
  );
}
