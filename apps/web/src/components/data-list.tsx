import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One column of a list, described once and rendered twice: as a `<th>/<td>`
 * pair at `md+`, and as a line of the stacked row card below it.
 */
export type DataListColumn<Row> = {
  /** Stable identity for the column. Also the React key. */
  key: string;
  /** Column heading, and the label of the card's label/value line. */
  header: string;
  cell: (row: Row) => ReactNode;
  /** The row's identity. First column in the table, card title on a phone. */
  primary?: boolean;
  /** The state pill. Last column in the table, top-right of the card. */
  status?: boolean;
  /** The row's action. Right-aligned in the table, full width on the card. */
  action?: boolean;
  /** Right-aligned and `tabular-nums`: amounts, counts, dates in a column. */
  numeric?: boolean;
  /** Detail that earns a table cell but only adds noise to a phone card. */
  hideOnMobile?: boolean;
  /** Extra classes on the `<td>` and the card's value. */
  className?: string;
};

/**
 * The one way to show rows.
 *
 * At `md+` it is a real `<table>` inside `overflow-x-auto rounded-xl border
 * bg-card`, so a wide table scrolls inside its own box and never drags the page
 * body sideways. Under `md` the same column definitions render as stacked
 * cards. Both trees are always in the DOM and one is switched off with
 * `display: none`, which keeps the component a server component with no layout
 * measurement — worth knowing when writing selectors: only the visible tree is
 * in the accessibility tree, so `getByRole` resolves once, while a raw
 * `getByText` can see both.
 */
export function DataList<Row>({
  rows,
  columns,
  getRowKey,
  caption,
  empty,
  className,
}: {
  rows: readonly Row[];
  columns: readonly DataListColumn<Row>[];
  getRowKey: (row: Row, index: number) => string;
  /** Names the table for a screen reader. Not painted. */
  caption?: string;
  /** Shown instead of the list when there are no rows — usually an EmptyState. */
  empty?: ReactNode;
  className?: string;
}) {
  if (rows.length === 0) return empty ?? null;

  const primary = columns.find((column) => column.primary) ?? columns[0]!;
  const status = columns.find((column) => column.status);
  const action = columns.find((column) => column.action);
  // Everything the card shows as a label/value pair: not the title, not the
  // pill, not the action, and not the columns marked table-only.
  const detail = columns.filter(
    (column) => column !== primary && column !== status && column !== action && !column.hideOnMobile,
  );

  return (
    <div className={cn("min-w-0", className)}>
      {/* Table, md and up. */}
      <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
        <table className="w-full border-collapse text-row">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr className="border-b">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "label-caps px-4 py-2.5 text-left whitespace-nowrap text-muted-foreground",
                    (column.numeric || column.action) && "text-right",
                  )}
                >
                  {column.action ? <span className="sr-only">{column.header}</span> : column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={getRowKey(row, index)} className="border-b transition-colors last:border-0 hover:bg-muted/50">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "px-4 py-3 align-middle",
                      column === primary ? "font-medium" : "text-muted-foreground",
                      column.numeric && "text-right tabular-nums",
                      column.action && "text-right whitespace-nowrap",
                      column.className,
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Stacked row cards, under md. */}
      <ul className="grid gap-3 md:hidden">
        {rows.map((row, index) => (
          <li key={getRowKey(row, index)} className="min-w-0 rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-sm font-medium break-words">{primary.cell(row)}</div>
              {status ? <div className="shrink-0">{status.cell(row)}</div> : null}
            </div>

            {detail.length > 0 ? (
              <dl className="mt-3 grid gap-1.5">
                {detail.map((column) => (
                  <div key={column.key} className="flex items-baseline justify-between gap-3">
                    <dt className="label-caps shrink-0 text-muted-foreground">{column.header}</dt>
                    <dd className={cn("min-w-0 text-row break-words text-right", column.className)}>
                      {column.cell(row)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {action ? (
              <div className="mt-3 [&_a]:w-full [&_button]:w-full [&>*]:w-full">{action.cell(row)}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
