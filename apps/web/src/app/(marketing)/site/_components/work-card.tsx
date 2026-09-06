import Link from "next/link";
import { STATUS_LABEL, type WorkItem } from "@/lib/marketing/work";
import { Shot } from "./shot";
import { Tag } from "./primitives";

/**
 * One project on a grid: the screenshot, the name, one line, the tags. The
 * whole card is the link — a thumb on a phone should not have to find the
 * word "View".
 */
export function WorkCard({ item, href, priority = false }: { item: WorkItem; href: string; priority?: boolean }) {
  return (
    <Link href={href} className="group block rounded-xl outline-offset-4">
      <Shot src={item.screenshots.desktop} alt={`${item.name} website`} name={item.name} priority={priority} className="transition-colors group-hover:border-primary/60" />
      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-semibold group-hover:underline">{item.name}</h3>
          {item.charity ? <Tag className="border-success-border bg-success-bg text-success-fg">Built free</Tag> : null}
          {item.status !== "live" ? <Tag>{STATUS_LABEL[item.status]}</Tag> : null}
        </div>
        <p className="mt-1 text-muted-foreground">{item.summary}</p>
        <p className="mt-2 text-meta text-muted-foreground">
          {item.sector} · {item.year}
        </p>
      </div>
    </Link>
  );
}
