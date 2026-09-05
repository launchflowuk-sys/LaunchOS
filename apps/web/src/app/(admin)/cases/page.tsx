import { listClients, listMembers } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, notInArray, type SQL } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager, pageParam } from "@/components/pager";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { ALL_STATUSES, CASE_FILTER_SCHEMA, CLOSED_STATUSES, isClosed } from "./filters";

export const dynamic = "force-dynamic";

const CONTROL = "h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";

/** An empty GET-form field arrives as "", which means "no filter". */
const one = (v: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw && raw.length > 0 ? raw : undefined;
};

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
  const now = new Date();

  return (
    <>
      <PageHeader title="Open Cases" description="Support work raised by clients, monitors and agents." />

      {/* A plain GET form: the filters live in the URL, so a filtered view is
          shareable and needs no client JavaScript. */}
      <form
        method="get"
        aria-label="Case filters"
        className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-3"
      >
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Status
          <select name="status" defaultValue={statusFilter ?? ""} className={`${CONTROL} min-w-40`}>
            <option value="">Open only</option>
            <option value={ALL_STATUSES}>All statuses</option>
            {schema.ticketStatusEnum.enumValues.map((v) => (
              <option key={v} value={v}>
                {v.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Severity
          <select name="severity" defaultValue={severityFilter ?? ""} className={`${CONTROL} min-w-40`}>
            <option value="">Any</option>
            {schema.severityEnum.enumValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Assignee
          <select name="assignee" defaultValue={assigneeFilter ?? ""} className={`${CONTROL} min-w-40`}>
            <option value="">Any</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName ?? m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Client
          <select name="clientId" defaultValue={clientFilter ?? ""} className={`${CONTROL} min-w-40`}>
            <option value="">Any</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState>{page > 1 ? "No more cases on this page." : "No cases match this view."}</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>SLA due</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const breached =
                  !!row.slaDueAt && row.slaDueAt < now && !isClosed(row.status);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-neutral-900">
                      <Link href={`/cases/${row.id}`} className="underline-offset-2 hover:underline">
                        {row.subject}
                      </Link>
                    </TableCell>
                    <TableCell className="text-neutral-600">{row.clientName}</TableCell>
                    <TableCell>
                      <StatusBadge value={row.severity} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <StatusBadge value={row.status} />
                      {/* Only the exception is called out: most cases the list
                          shows are the client's own, and a badge on every row
                          would say nothing. */}
                      {row.clientVisible ? null : <StatusBadge value="Internal" tone="neutral" />}
                    </TableCell>
                    <TableCell className="text-neutral-600">{row.assigneeName ?? "Unassigned"}</TableCell>
                    <TableCell
                      className={`whitespace-nowrap ${breached ? "font-medium text-red-600" : "text-neutral-600"}`}
                    >
                      {formatDateTime(row.slaDueAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-neutral-600">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

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
