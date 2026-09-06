import Link from "next/link";
import { STATUS_LABEL, type WorkItem } from "@/lib/marketing/work";
import { Pill } from "./primitives";
import { Shot } from "./shot";

/**
 * One project on a grid: the screenshot with its ↗ chip, the sector-and-year
 * eyebrow, the name, one line. The whole card is the link — a thumb on a
 * phone should not have to find the word "View" — and the image tilts on
 * hover.
 */
export function WorkCard({ item, href, priority = false, sizes }: { item: WorkItem; href: string; priority?: boolean; sizes?: string }) {
  return (
    <Link href={href} className="tilt group block rounded-2xl outline-offset-4" data-reveal>
      <Shot
        src={item.screenshots.desktop}
        alt={`${item.name} website`}
        name={item.name}
        priority={priority}
        chip
        inner
        sizes={sizes ?? "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"}
      />
      <div className="mt-5">
        <p className="eyebrow eyebrow-index">
          <span>
            {item.kind === "client" ? "Web app" : "Product"} · {item.sector} · {item.year}
          </span>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h3 className="h-card group-hover:text-[var(--blue)] transition-colors">{item.name}</h3>
          {item.charity ? <Pill tone="live">Built free</Pill> : null}
          {item.status !== "live" ? <Pill>{STATUS_LABEL[item.status]}</Pill> : null}
        </div>
        <p className="body mt-1.5">{item.summary}</p>
      </div>
    </Link>
  );
}
