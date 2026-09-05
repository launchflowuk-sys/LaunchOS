import type { OpsBrief } from "@launchos/core";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import Markdown from "react-markdown";
import { formatDateTime } from "@/lib/format";
import { isInAppPath } from "@/lib/in-app-path";
import { briefDateLabel } from "./format";

/**
 * The "needs you" list as pills. A highlight with a link the app recognises
 * is a link; anything else is a label. The link is stored free text by an
 * agent, so only an in-app path is ever rendered clickable.
 */
export function Highlights({ items, compact = false }: { items: OpsBrief["highlights"]; compact?: boolean }) {
  if (items.length === 0) {
    return <p className="text-sm text-success-fg">Nothing needs you today.</p>;
  }
  return (
    <ul className={compact ? "flex flex-wrap gap-2" : "grid gap-2"} aria-label="Needs you">
      {items.map((item, index) => {
        const inner = (
          <>
            <span className="font-medium">{item.label}</span>
            {!compact && item.detail ? <span className="text-muted-foreground"> — {item.detail}</span> : null}
            {isInAppPath(item.link) ? (
              <ArrowUpRight aria-hidden strokeWidth={1.75} className="ml-1 inline size-3.5 align-[-2px]" />
            ) : null}
          </>
        );
        const pill =
          "inline-flex max-w-full items-baseline rounded-full border border-warning-border bg-warning-bg px-3 py-1 text-row text-warning-fg";
        return (
          <li key={`${index}-${item.label}`} className="min-w-0">
            {isInAppPath(item.link) ? (
              <Link href={item.link} className={`${pill} transition-colors hover:border-warning-fg/40`}>
                {inner}
              </Link>
            ) : (
              <span className={pill}>{inner}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One brief in full: its day, what needs you, and the body the agent wrote. */
export function BriefArticle({ brief }: { brief: OpsBrief }) {
  return (
    <article className="rounded-xl border bg-card p-4 sm:p-6">
      <header className="mb-4 border-b pb-4">
        <h2 className="text-lg font-semibold tracking-[-0.01em]">{briefDateLabel(brief.briefDate)}</h2>
        <p className="mt-1 text-meta text-muted-foreground">
          Written {formatDateTime(brief.createdAt)}
          {brief.updatedAt.getTime() - brief.createdAt.getTime() > 60_000
            ? ` · replaced ${formatDateTime(brief.updatedAt)}`
            : ""}
          {brief.agentRunId ? (
            <>
              {" · "}
              <Link href={`/agents/runs/${brief.agentRunId}`} className="underline underline-offset-2">
                agent run
              </Link>
            </>
          ) : null}
        </p>
        <div className="mt-3">
          <Highlights items={brief.highlights} />
        </div>
      </header>
      {/* `react-markdown` renders text, not HTML, and no `rehype-raw` is added:
          the body stays inert however it was written. Relative links such as
          `[Approvals](/approvals)` stay relative, so they open in this app. */}
      <div className="prose prose-sm max-w-none">
        <Markdown>{brief.bodyMd}</Markdown>
      </div>
    </article>
  );
}
