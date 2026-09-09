"use client";

import { HelpCircle, Loader2 } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Markdown from "react-markdown";
import { useState, useTransition } from "react";
import { helpForCurrentRoute } from "@/app/(admin)/help-actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

type Article = { id: string; title: string; slug: string; bodyMd: string };

/**
 * Help for wherever you are, on every screen.
 *
 * The point is coverage, not cleverness. Nobody can predict where a particular
 * person gets stuck — so rather than guessing at the hard bits, this sits in
 * the header of every screen and answers "how do I do this here". A screen with
 * nothing written says so plainly and links to where a guide gets written,
 * which is what keeps the gaps visible instead of quietly absent.
 *
 * Loaded when it is opened rather than with the page: the shell is rendered on
 * every navigation and most of them are not somebody stuck.
 */
export function HelpButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ route: string; articles: Article[] } | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    // Re-read every time. The person may have moved screens since last time,
    // and a guide may have been written since.
    setState(null);
    startTransition(async () => {
      setState(await helpForCurrentRoute(pathname));
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Help for this screen">
          <HelpCircle className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>How to use this screen</SheetTitle>
        </SheetHeader>

        <div className="min-w-0 px-4 pb-8">
          {pending || state === null ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Looking for guides…
            </p>
          ) : state.articles.length === 0 ? (
            <div className="space-y-3 py-4">
              <p className="text-sm text-muted-foreground">
                Nothing has been written for this screen yet.
              </p>
              <p className="text-sm text-muted-foreground">
                Guides are written once and then everyone has them. This screen is on the gaps list until one
                exists.
              </p>
              <Button asChild variant="secondary" onClick={() => setOpen(false)}>
                <Link href={`/knowledge/new?route=${encodeURIComponent(state.route)}`}>Write one for this screen</Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-8 py-2">
              {state.articles.map((article) => (
                <article key={article.id} className="min-w-0">
                  <h3 className="text-base font-semibold tracking-tight">{article.title}</h3>
                  {/* `react-markdown` renders text, not HTML, and no `rehype-raw`
                      is added — a guide is written by a person in the admin and
                      is still not a reason to allow markup through. */}
                  <div className="prose prose-sm mt-2 min-w-0 max-w-none">
                    <Markdown>{article.bodyMd}</Markdown>
                  </div>
                  <Link
                    href={`/knowledge/${article.slug}`}
                    className="mt-3 inline-block text-meta text-muted-foreground hover:underline"
                    onClick={() => setOpen(false)}
                  >
                    Open the full guide
                  </Link>
                </article>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
