import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type KeyValueItem = {
  label: string;
  value: ReactNode;
  /** A second line under the value: a note, a source, a "last checked". */
  hint?: string;
};

/**
 * The label/value rows a detail page is mostly made of. One column on a phone,
 * two from `sm` when `columns` says so, and the value always able to wrap —
 * domains, URLs and email addresses are the values that break a fixed row.
 */
export function KeyValue({
  items,
  columns = 1,
  className,
}: {
  items: readonly KeyValueItem[];
  columns?: 1 | 2;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid gap-x-8 gap-y-4",
        columns === 2 && "sm:grid-cols-2",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="label-caps text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 text-sm break-words">{item.value}</dd>
          {item.hint ? <p className="mt-0.5 text-meta text-muted-foreground">{item.hint}</p> : null}
        </div>
      ))}
    </dl>
  );
}
