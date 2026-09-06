import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The page column: 1216px at most, generous side padding, never wider than the phone. */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[76rem] px-5 sm:px-8", className)}>{children}</div>;
}

/** The ↗ that every action carries. `.arrow` is what the hover nudge targets. */
export function Arrow({ className, kind = "up" }: { className?: string; kind?: "up" | "right" }) {
  const Icon = kind === "up" ? ArrowUpRight : ArrowRight;
  return <Icon aria-hidden className={cn("arrow size-4", className)} strokeWidth={2} />;
}

/**
 * The small uppercase label above a heading. With `index` it reads
 * "01 / SELECTED WORK"; with `line` it carries the short hairline before it.
 */
export function Eyebrow({
  children,
  index,
  line = false,
  className,
  as: Tag = "p",
}: {
  children: ReactNode;
  index?: string | undefined;
  line?: boolean;
  className?: string | undefined;
  as?: "p" | "span" | "div";
}) {
  if (index) {
    return (
      <Tag className={cn("eyebrow eyebrow-index", className)}>
        <b>{index}</b>
        <span aria-hidden>/</span>
        <span>{children}</span>
      </Tag>
    );
  }
  return <Tag className={cn("eyebrow", line && "eyebrow-line", className)}>{children}</Tag>;
}

type Tone = "ink" | "blue" | "white" | "white-solid";

const TONE: Record<Tone, string> = {
  ink: "btn-ink",
  blue: "btn-blue",
  white: "btn-white",
  "white-solid": "btn-white-solid",
};

/**
 * The pill button, as a link. Primary is ink; the hero and the CTA panel
 * choose blue and white. Every one carries the ↗ unless told otherwise.
 */
export function Btn({
  href,
  children,
  tone = "ink",
  size = "md",
  arrow = true,
  external = false,
  className,
  ariaLabel,
}: {
  href: string;
  children: ReactNode;
  tone?: Tone;
  size?: "md" | "lg";
  arrow?: boolean;
  external?: boolean;
  className?: string | undefined;
  ariaLabel?: string | undefined;
}) {
  const classes = cn("btn", TONE[tone], size === "lg" && "btn-lg", className);
  const content = (
    <>
      {children}
      {arrow ? <Arrow /> : null}
    </>
  );
  if (external) {
    return (
      <a href={href} className={classes} rel="noopener" aria-label={ariaLabel}>
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} aria-label={ariaLabel}>
      {content}
    </Link>
  );
}

/** A text link with the arrow: ink at rest, blue on hover. */
export function TextLink({
  href,
  children,
  kind = "up",
  tone = "ink",
  external = false,
  className,
}: {
  href: string;
  children: ReactNode;
  kind?: "up" | "right";
  tone?: "ink" | "quiet" | "white";
  external?: boolean | undefined;
  className?: string | undefined;
}) {
  const classes = cn("tlink", tone === "quiet" && "tlink-quiet", tone === "white" && "tlink-white", className);
  const content = (
    <>
      {children}
      <Arrow kind={kind} />
    </>
  );
  if (external) {
    return (
      <a href={href} className={classes} rel="noopener">
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {content}
    </Link>
  );
}

/**
 * A section opener: the index eyebrow, a two-line heading, and — beside it on
 * a desktop — an aside paragraph with a link. The pattern every home section
 * and every inner page opens with.
 */
export function SectionHead({
  index,
  eyebrow,
  title,
  aside,
  link,
  align = "left",
  className,
  level = 2,
  id,
}: {
  index?: string;
  eyebrow: string;
  title: ReactNode;
  aside?: ReactNode;
  link?: { label: string; href: string; external?: boolean };
  align?: "left" | "right";
  className?: string;
  level?: 1 | 2;
  id?: string;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  const headingClass = level === 1 ? "h-page mt-5" : "h-section mt-5";
  return (
    <div className={cn("grid gap-8 lg:grid-cols-12 lg:items-end", className)}>
      <div className={cn("lg:col-span-7", align === "right" && "lg:col-start-6 lg:text-right")} data-reveal>
        <Eyebrow index={index}>{eyebrow}</Eyebrow>
        <Heading id={id} className={headingClass}>{title}</Heading>
      </div>
      {aside || link ? (
        <div className={cn("lg:col-span-5", align === "right" && "lg:col-start-1 lg:row-start-1")} data-reveal>
          {aside ? <p className="lede">{aside}</p> : null}
          {link ? (
            <div className={cn(aside ? "mt-5" : "")}>
              <TextLink href={link.href} external={link.external}>
                {link.label}
              </TextLink>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Two lines of a heading, the second on its own row. */
export function Lines({ first, second, secondClass }: { first: ReactNode; second: ReactNode; secondClass?: string }) {
  return (
    <>
      {first}
      <br />
      <span className={secondClass}>{second}</span>
    </>
  );
}

/** A small uppercase tag — sector, stack, status. Never a button. */
export function Pill({ children, tone = "default", className }: { children: ReactNode; tone?: "default" | "live" | "tint"; className?: string }) {
  return <span className={cn("pill", tone === "live" && "pill-live", tone === "tint" && "pill-tint", className)}>{children}</span>;
}

/** The blue-tinted chip: a stack item, a service point. */
export function Chip({ children }: { children: ReactNode }) {
  return <li className="chip">{children}</li>;
}
