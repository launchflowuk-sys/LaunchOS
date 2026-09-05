import { listClients, listMembers } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, notInArray, type SQL } from "drizzle-orm";
import { LifeBuoy } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager, pageParam } from "@/components/pager";
import { StatusBadge } from "@/components/status-badge";
import { Toolbar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { ALL_STATUSES, CASE_FILTER_SCHEMA, CLOSED_STATUSES, isClosed } from "./filters";

export const dynamic = "force-dynamic";

/**
 * A native `<select>` on purpose: the filters are a plain GET form, so the
 * screen keeps working with no client JavaScript and a shared link reproduces
 * the view. The control shape comes from the shared `NativeSelect`; the only
 * thing this adds is the column width the filter row wants.
 */
function FilterSelect({
  name,
  defaultValue,
  id,
  children,
}: {
  name: string;
  defaultValue: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <NativeSelect id={id} name={name} defaultValue={defaultValue} className="sm:w-44">
      {children}
    </NativeSelect>
  );
}

/** An empty GET-form field arrives as "", which means "no filter". */
const one = (v: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw && raw.length > 0 ? raw : undefined;
};

type Row = {
  id: string;
  subject: string;
  severity: string;
  status: string;
  slaDueAt: Date | null;
  clientVisible: boolean;
  resolvedAt: Date | null;
  createdAt: Date;
  clientName: string;
  assigneeName: string | null;
};

function columnsFor(now: Date): readonly DataListColumn<Row>[] {
  return [
    {
      key: "subject",
      header: "Subject",
      primary: true,
      cell: (row) => (
        <Link href={`/cases/${row.id}`} className="underline-offset-2 hover:underline">
          {row.subject}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      status: true,
      className: "whitespace-nowrap",
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusBadge value={row.status} />
          {/* Only the exception is called out: most cases the list shows are
              the client's own, and a badge on every row would say nothing. */}
          {row.clientVisible ? null : <StatusBadge value="Internal" tone="neutral" />}
        </span>
      ),
    },
    { key: "client", header: "Client", cell: (row) => row.clientName },
    { key: "severity", header: "Severity", cell: (row) => <StatusBadge value={row.severity} /> },
    {
      key: "assignee",
      header: "Assignee",
      cell: (row) =>
        row.assigneeName ?? <span className="text-warning-fg">Unassigned</span>,
    },
    {
      key: "sla",
      header: "SLA due",
      className: "whitespace-nowrap",
      cell: (row) => {
        const breached = !!row.slaDueAt && row.slaDueAt < now && !isClosed(row.status);
        return breached ? (
          <span className="font-medium text-danger-fg">{formatDateTime(row.slaDueAt)}</span>
        ) : (
          formatDateTime(row.slaDueAt)
        );
      },
    },
    {
      key: "created",
      header: "Created",
      hideOnMobile: true,
      className: "whitespace-nowrap",
      cell: (row) => formatDateTime(row.createdAt),
    },
  ];
}

export default async function CasesPage({ searchParams }: PageProps<"/cases">) {
  const session = await requireAdmin();
  const sp = await searchParams;

  // Each filter is validated on its own, and an unrecognised value is dropped
  // rather than thrown: a hand-edited URL must not 500 the screen.
  const status = CASE_FILTER_SCHEMA.shape.status.safeParse(one(sp.status));
  const severity = CASE_FILTER_SCHEMA.shape.severity.safeParse(one(sp.severity));
  const assignee = CASE_FILTER_SCHEMA.shape.assignee.safeParse(one(sp.assignee));
  const clientId = CASE_FILTER_SCHEMA.shape.clientId.safeParse(one(sp.clientId));

  const statusFilter = status.success ? status.data : undefined;
  const severityFilter = severity.success ? severity.data : undefined;
  const assigneeFilter = assignee.success ? assignee.data : undefined;
  const clientFilter = clientId.success ? clientId.data : undefined;
  const page = pageParam(sp.page);

  const conditions: SQL[] = [eq(schema.tickets.organisationId, session.organisationId)];
  // Three cases: one status, "all" (no condition at all, so a case closed last
  // week is still reachable), or — the default "Open Cases" view — everything
  // whose work is not finished.
  if (statusFilter && statusFilter !== ALL_STATUSES) {
    conditions.push(eq(schema.tickets.status, statusFilter));
  } else if (!statusFilter) {
    conditions.push(notInArray(schema.tickets.status, [...CLOSED_STATUSES]));
  }
  if (severityFilter) conditions.push(eq(schema.tickets.severity, severityFilter));
  if (assigneeFilter) conditions.push(eq(schema.tickets.assignedUserId, assigneeFilter));
  if (clientFilter) conditions.push(eq(schema.tickets.clientId, clientFilter));

  const [found, clients, members] = await Promise.all([
    getDb()
      .select({
        id: schema.tickets.id,
        subject: schema.tickets.subject,
        severity: schema.tickets.severity,
        status: schema.tickets.status,
        slaDueAt: schema.tickets.slaDueAt,
        clientVisible: schema.tickets.clientVisible,
        resolvedAt: schema.tickets.resolvedAt,
        createdAt: schema.tickets.createdAt,
        clientName: schema.clients.name,
        assigneeName: schema.user.name,
      })
      .from(schema.tickets)
      .innerJoin(schema.clients, eq(schema.tickets.clientId, schema.clients.id))
      .leftJoin(schema.user, eq(schema.tickets.assignedUserId, schema.user.id))
      .where(and(...conditions))
      .orderBy(desc(schema.tickets.createdAt))
      // One extra row answers "is there a next page" without a second count query.
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE),
    listClients(getDb(), session.organisationId, { limit: 200 }),
    listMembers(getDb(), session.organisationId),
  ]);

  const hasNext = found.length > PAGE_SIZE;
  const rows = hasNext ? found.slice(0, PAGE_SIZE) : found;

  return (
    <>
      <PageHeader
        title="Open Cases"
        description="Support work raised by clients, monitors and agents."
        category="support"
      />

      {/* A plain GET form: the filters live in the URL, so a filtered view is
          shareable and needs no client JavaScript. */}
      <form method="get" aria-label="Case filters">
        <Toolbar>
          <ToolbarField label="Status" htmlFor="filter-status">
            <FilterSelect id="filter-status" name="status" defaultValue={statusFilter ?? ""}>
              <option value="">Open only</option>
              <option value={ALL_STATUSES}>All statuses</option>
              {schema.ticketStatusEnum.enumValues.map((v) => (
                <option key={v} value={v}>
                  {v.replaceAll("_", " ")}
                </option>
              ))}
            </FilterSelect>
          </ToolbarField>
          <ToolbarField label="Severity" htmlFor="filter-severity">
            <FilterSelect id="filter-severity" name="severity" defaultValue={severityFilter ?? ""}>
              <option value="">Any</option>
              {schema.severityEnum.enumValues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </FilterSelect>
          </ToolbarField>
          <ToolbarField label="Assignee" htmlFor="filter-assignee">
            <FilterSelect id="filter-assignee" name="assignee" defaultValue={assigneeFilter ?? ""}>
              <option value="">Any</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName ?? m.name}
                </option>
              ))}
            </FilterSelect>
          </ToolbarField>
          <ToolbarField label="Client" htmlFor="filter-client">
            <FilterSelect id="filter-client" name="clientId" defaultValue={clientFilter ?? ""}>
              <option value="">Any</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </FilterSelect>
          </ToolbarField>
          <ToolbarActions>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </ToolbarActions>
        </Toolbar>
      </form>

      <DataList
        rows={rows}
        columns={columnsFor(new Date())}
        getRowKey={(row) => row.id}
        caption="Cases"
        empty={
          <EmptyState icon={LifeBuoy}>
            {page > 1 ? "No more cases on this page." : "No cases match this view."}
          </EmptyState>
        }
      />

      {/* Only the filters that survived validation are carried across pages. */}
      <Pager
        basePath="/cases"
        query={{
          status: statusFilter,
          severity: severityFilter,
          assignee: assigneeFilter,
          clientId: clientFilter,
        }}
        page={page}
        hasNext={hasNext}
      />
    </>
  );
}
