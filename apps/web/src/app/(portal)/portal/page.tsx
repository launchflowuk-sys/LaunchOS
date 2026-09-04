import { listSites, listTasks } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, count, desc, eq, notInArray } from "drizzle-orm";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

const CLOSED_TICKET_STATUSES = ["resolved", "closed"] as const;
/** Everything `task_status` offers except the two finished states. */
const ACTIVE_TASK_STATUSES = ["todo", "in_progress", "blocked", "review"] as const;

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-5">
      <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</h2>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Figure({ value, caption }: { value: number; caption: string }) {
  return (
    <>
      <p className="text-3xl font-semibold tabular-nums text-neutral-900">{value}</p>
      <p className="mt-1 text-sm text-neutral-500">{caption}</p>
    </>
  );
}

export default async function PortalHomePage() {
  const session = await requireClient();
  const db = getDb();
  const scope = { organisationId: session.organisationId, clientId: session.clientId };

  const [liveSites, openTickets, openTasks, latestConversation] = await Promise.all([
    listSites(db, scope.organisationId, { clientId: scope.clientId, status: "live" }),
    db
      .select({ total: count() })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.organisationId, scope.organisationId),
          eq(schema.tickets.clientId, scope.clientId),
          notInArray(schema.tickets.status, [...CLOSED_TICKET_STATUSES]),
        ),
      ),
    listTasks(db, scope.organisationId, {
      clientId: scope.clientId,
      clientVisible: true,
      status: [...ACTIVE_TASK_STATUSES],
    }),
    db
      .select({
        subject: schema.conversations.subject,
        ticketId: schema.conversations.ticketId,
        lastMessageAt: schema.conversations.lastMessageAt,
      })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.organisationId, scope.organisationId),
          eq(schema.conversations.clientId, scope.clientId),
        ),
      )
      .orderBy(desc(schema.conversations.lastMessageAt), desc(schema.conversations.createdAt))
      .limit(1),
  ]);

  const openTicketCount = openTickets[0]?.total ?? 0;
  const latest = latestConversation[0];

  return (
    <>
      <PageHeader title={`Hello, ${session.name}`} description="Everything we are looking after for you." />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Websites live">
          {liveSites.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing live yet — we will let you know as soon as it is.</p>
          ) : (
            <Figure value={liveSites.length} caption={liveSites.length === 1 ? "site online" : "sites online"} />
          )}
        </Card>

        <Card title="Open requests">
          {openTicketCount === 0 ? (
            <p className="text-sm text-neutral-500">
              Nothing open.{" "}
              <Link href="/portal/support/new" className="font-medium text-neutral-900 hover:underline">
                Raise a request
              </Link>
              .
            </p>
          ) : (
            <Figure value={openTicketCount} caption={openTicketCount === 1 ? "request with us" : "requests with us"} />
          )}
        </Card>

        <Card title="Work in progress">
          {openTasks.length === 0 ? (
            <p className="text-sm text-neutral-500">No open work right now.</p>
          ) : (
            <Figure value={openTasks.length} caption={openTasks.length === 1 ? "task underway" : "tasks underway"} />
          )}
        </Card>

        <Card title="Latest conversation">
          {!latest ? (
            <p className="text-sm text-neutral-500">Nothing yet.</p>
          ) : latest.ticketId ? (
            <>
              <Link
                href={`/portal/support/${latest.ticketId}`}
                className="text-sm font-medium text-neutral-900 hover:underline"
              >
                {latest.subject}
              </Link>
              <p className="mt-1 text-xs text-neutral-500">{formatDateTime(latest.lastMessageAt)}</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-neutral-900">{latest.subject}</p>
              <p className="mt-1 text-xs text-neutral-500">{formatDateTime(latest.lastMessageAt)}</p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
