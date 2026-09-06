import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Container } from "./primitives";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";
import "../marketing.css";
import "../motion.css";

/**
 * The frame for a public page that lives outside the `(marketing)` group —
 * `/book` and `/signup` — so a visitor who arrives from the site or an email
 * sees the same header, footer and type as the site itself. One heading,
 * one line under it, then the content.
 */
export function PublicShell({
  title,
  description,
  children,
  narrow = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  /** A single-column page (a done screen). */
  narrow?: boolean;
}) {
  return (
    <div id="top" className="marketing flex min-h-screen flex-1 flex-col">
      <SiteHeader />
      <main className="flex-1">
        <Container className={cn("py-12 sm:py-16", narrow && "max-w-xl")}>
          <div className={cn("mb-8", narrow ? "text-center" : "max-w-2xl")}>
            <h1 className="h-page">{title}</h1>
            <p className={cn("lede mt-4", narrow && "mx-auto")}>{description}</p>
          </div>
          {children}
        </Container>
      </main>
      <SiteFooter />
    </div>
  );
}
