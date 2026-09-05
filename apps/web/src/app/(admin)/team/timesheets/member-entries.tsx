import { formatMinutes, type Timesheet, type TimesheetEntry } from "@launchos/core";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { StatusBadge } from "@/components/status-badge";
import { dayFull, timeOfDay } from "./week";

type EntryRow = TimesheetEntry & { day: string };

const COLUMNS: readonly DataListColumn<EntryRow>[] = [
  { key: "day", header: "Day", primary: true, cell: (row) => dayFull(row.day) },
  { key: "start", header: "Started", cell: (row) => <span className="tabular-nums">{timeOfDay(row.startedAt)}</span> },
  {
    key: "end",
    header: "Ended",
    cell: (row) => (row.endedAt ? <span className="tabular-nums">{timeOfDay(row.endedAt)}</span> : "—"),
  },
  { key: "duration", header: "Duration", numeric: true, cell: (row) => formatMinutes(row.minutes) },
  {
    key: "against",
    header: "Against",
    cell: (row) => {
      if (row.taskId) {
        return (
          <Link href={`/tasks/${row.taskId}`} className="hover:underline">
            {row.taskTitle ?? "Task"}
          </Link>
        );
      }
      if (row.ticketId) {
        return (
          <Link href={`/cases/${row.ticketId}`} className="hover:underline">
            {row.ticketSubject ?? "Case"}
          </Link>
        );
      }
      return <span className="text-muted-foreground">Clocked in</span>;
    },
  },
  { key: "note", header: "Note", hideOnMobile: true, cell: (row) => row.note ?? "—" },
  {
    key: "status",
    header: "Status",
    status: true,
    cell: (row) => (row.running ? <StatusBadge value="running" tone="info" /> : null),
  },
];

/**
 * One member's week, entry by entry, behind a native `<details>` so a team
 * of ten does not open as ten tables. The summary carries the total, which is
 * the number most readers came for. Not a card: the list inside brings its
 * own surface (a table at `md+`, stacked cards below), and a card inside a
 * card is the one thing DESIGN.md rules out.
 */
export function MemberEntries({ name, sheet, open = false }: { name: string; sheet: Timesheet; open?: boolean }) {
  const rows: EntryRow[] = sheet.days.flatMap((day) => day.entries.map((entry) => ({ ...entry, day: day.date })));
  return (
    <details open={open} className="py-2">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden">
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">
          {rows.length === 0 ? "nothing logged" : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
        </span>
        <span className="ml-auto font-medium tabular-nums">{formatMinutes(sheet.totalMinutes)}</span>
      </summary>
      <div className="mt-2 mb-2">
        {rows.length > 0 ? (
          <DataList rows={rows} columns={COLUMNS} getRowKey={(row) => row.id} caption={`${name}'s entries this week`} />
        ) : (
          <p className="px-2 text-sm text-muted-foreground">Nothing logged this week.</p>
        )}
      </div>
    </details>
  );
}
