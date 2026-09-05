import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import { Mails } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager, pageParam } from "@/components/pager";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { lastMessageDirection } from "./thread-filters";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  subject: string;
  status: string;
  channel: string;
  participantEmail: string | null;
  lastMessageAt: Date | null;
  ticketId: string | null;
  clientName: string;
  lastDirection: string | null;
};

/** The last word on the thread is theirs, so it is still ours to answer. */
const needsReply = (row: Row): boolean => row.lastDirection === "inbound";

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "subject",
    header: "Subject",
    primary: true,
    cell: (row) => (
      <Link href={`/inbox/${row.id}`} className="underline-offset-2 hover:underline">
        {row.subject}
      </Link>
    ),
  },
  {
    key: "state",
    header: "State",
    status: true,
    cell: (row) => {
      if (needsReply(row)) return <StatusBadge value="needs reply" tone="warn" />;
      // An open conversation is the calm state here — unlike an open incident —
      // so it must not borrow the alarm colour the shared map gives that word.
      if (row.status === "open") return <StatusBadge value="open" tone="neutral" />;
      return <StatusBadge value={row.status} />;
    },
  },
  { key: "client", header: "Client", cell: (row) => row.clientName },
  { key: "from", header: "From", hideOnMobile: true, cell: (row) => row.participantEmail ?? "—" },
  { key: "channel", header: "Channel", hideOnMobile: true, cell: (row) => row.channel },
  {
    key: "last",
    header: "Last message",
    className: "whitespace-nowrap",
    cell: (row) => formatDateTime(row.lastMessageAt),
  },
];

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
      <PageHeader title="Inbox" description="Every client conversation, newest first." category="support" />

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Conversations"
        empty={
          <EmptyState icon={Mails}>
            {page > 1
              ? "No more conversations on this page."
              : "No conversations yet. Mail sent to a client's support address appears here."}
          </EmptyState>
        }
      />

      <Pager basePath="/inbox" query={{}} page={page} hasNext={hasNext} />
    </>
  );
}
