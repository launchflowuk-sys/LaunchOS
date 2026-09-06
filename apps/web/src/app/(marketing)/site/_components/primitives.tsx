import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The page column: the same width as the admin workspace, generous side padding. */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>{children}</div>;
}

/**
 * A page opener: one heading, one lead paragraph, nothing else. Marketing
 * pages have exactly one `h1` and it is this.
 */
export function PageIntro({ title, lede, children }: { title: string; lede?: string; children?: ReactNode }) {
  return (
    <Container className="pt-14 pb-10 sm:pt-20 sm:pb-14">
      <h1 className="display max-w-3xl text-4xl sm:text-5xl">{title}</h1>
      {lede ? <p className="lede mt-5 max-w-2xl text-lg text-muted-foreground sm:text-xl">{lede}</p> : null}
      {children}
    </Container>
  );
}

/** A run of a page: a heading, optionally a line under it, then the content. */
export function Block({
  title,
  lede,
  children,
  className,
  id,
}: {
  title?: string;
  lede?: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("py-12 sm:py-16", className)}>
      <Container>
        {title ? (
          <div className="mb-8 max-w-2xl sm:mb-10">
            <h2 className="display text-2xl sm:text-3xl">{title}</h2>
            {lede ? <p className="lede mt-3 text-base text-muted-foreground sm:text-lg">{lede}</p> : null}
          </div>
        ) : null}
        {children}
      </Container>
    </section>
  );
}

/** The one place the navy from the admin rail appears on the public site: the closing invitation. */
export function CtaBand({
  title,
  lede,
  primary,
  secondary,
}: {
  title: string;
  lede: string;
  primary: { label: string; href: string };
  secondary?: { label: string; href: string };
}) {
  return (
    <section className="bg-sidebar text-sidebar-accent-foreground">
      <Container className="py-14 sm:py-20">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <h2 className="display text-3xl sm:text-4xl">{title}</h2>
            <p className="lede mt-4 text-base text-sidebar-foreground sm:text-lg">{lede}</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row lg:shrink-0">
            <Link
              href={primary.href}
              className={cn(
                buttonVariants({ size: "lg" }),
                "border-white bg-white text-sidebar hover:bg-white/90 focus-visible:outline-sidebar-ring",
              )}
            >
              {primary.label}
            </Link>
            {secondary ? (
              <Link
                href={secondary.href}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "lg" }),
                  "border-sidebar-border text-sidebar-accent-foreground hover:bg-sidebar-accent focus-visible:outline-sidebar-ring",
                )}
              >
                {secondary.label}
              </Link>
            ) : null}
          </div>
        </div>
      </Container>
    </section>
  );
}

/** A small uppercase tag — sector, stack, kind. Never a button. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border bg-background px-2.5 py-0.5 text-meta font-medium text-muted-foreground", className)}>
      {children}
    </span>
  );
}

/** A primary or secondary link styled as a button, for server components. */
export function LinkButton({
  href,
  children,
  variant = "primary",
  size = "lg",
  className,
  external = false,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "lg";
  className?: string;
  external?: boolean;
}) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (external) {
    return (
      <a href={href} className={classes} rel="noopener">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}
