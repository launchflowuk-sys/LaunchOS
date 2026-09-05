import { getClient } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { AtSign, LifeBuoy, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { DataList, type DataListColumn } from "@/components/data-list";
import { KeyValue } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { ClientTabs } from "../tabs";

export const dynamic = "force-dynamic";

/** Everything else is work still in flight. */
const FINISHED: ("resolved" | "closed")[] = ["resolved", "closed"];

const RECENT_CONVERSATIONS = 5;

const Uuid = z.string().uuid();

type TicketRow = {
  id: string;
  subject: string;
  severity: string;
  status: string;
  slaDueAt: Date | null;
  assigneeName: string | null;
};

const TICKET_COLUMNS: readonly DataListColumn<TicketRow>[] = [
  {
    key: "subject",
    header: "Case",
    primary: true,
    cell: (row) => (
      <Link href={`/cases/${row.id}`} className="hover:underline">
        {row.subject}
      </Link>
    ),
  },
  { key: "severity", header: "Severity", cell: (row) => <StatusBadge value={row.severity} /> },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: "sla",
    header: "SLA due",
    className: "whitespace-nowrap",
    cell: (row) => formatDateTime(row.slaDueAt),
  },
  {
    key: "assignee",
    header: "Assignee",
    cell: (row) =>
      row.assigneeName ?? <StatusBadge value="unassigned" tone="warn" label="unassigned" />,
  },
];

export default async function ClientSupportPage({ params }: PageProps<"/clients/[id]/support">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);
  const db = getDb();

  // A non-uuid path segment is a 404, not a Postgres uuid cast error.
  if (!Uuid.safeParse(id).success) notFound();

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
      <PageHeader
        title={client.name}
        description="Where this client's email lands, and what is still open."
        category="delivery"
      />

      <ClientTabs clientId={client.id} active="support" />

      <Section
        title="Support address"
        description="Mail to this address is turned into a conversation and a ticket by the inbound webhook."
      >
        {address ? (
          <div className="rounded-xl border bg-card p-4">
            <KeyValue
              columns={2}
              items={[
                { label: "Address", value: <span className="font-mono break-all">{address.address}</span> },
                { label: "Display name", value: address.displayName ?? client.name },
                { label: "Created", value: formatDateTime(address.createdAt) },
              ]}
            />
          </div>
        ) : (
          <EmptyState icon={AtSign}>
            No support address yet. It is created automatically for new clients; run <code>pnpm db:seed</code> to
            backfill this one.
          </EmptyState>
        )}
      </Section>

      <Section title="Open cases" description="Resolved and closed cases stay on the case list.">
        <DataList
          rows={tickets}
          columns={TICKET_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Open cases"
          empty={<EmptyState icon={LifeBuoy}>Nothing open for this client.</EmptyState>}
        />
      </Section>

      <Section title="Recent conversations" description="One is opened by the first email or portal message.">
        {conversations.length === 0 ? (
          <EmptyState icon={MessagesSquare}>No conversations yet.</EmptyState>
        ) : (
          <ul className="grid gap-3">
            {conversations.map((conversation) => (
              <li key={conversation.id} className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/inbox/${conversation.id}`} className="min-w-0 text-sm font-medium break-words hover:underline">
                    {conversation.subject}
                  </Link>
                  <p className="shrink-0 text-meta text-muted-foreground">
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
      </Section>
    </>
  );
}
