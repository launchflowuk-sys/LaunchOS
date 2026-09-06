import { Menu, X } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { buttonVariants } from "@/components/ui/button";
import { marketingLinks } from "@/lib/marketing/links";
import { NAV } from "@/lib/marketing/site";
import { cn } from "@/lib/utils";

/**
 * The wordmark, five links and one action. Under `md` the links fold into a
 * native `<details>` so the menu works with no client JavaScript at all —
 * a marketing page must be usable the instant its HTML arrives.
 */
export async function SiteHeader() {
  const { href, portalSignIn } = await marketingLinks();
  const items = NAV.map((item) => ({ ...item, href: href(item.path) }));

  return (
    <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-4 py-3 sm:px-6">
        <Link href={href("/")} className="shrink-0 rounded-md" aria-label="LaunchFlow home">
          <BrandMark width={128} priority />
        </Link>

        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {items.map((item) => (
              <li key={item.path}>
                <Link
                  href={item.href}
                  className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto hidden items-center gap-2 md:flex">
          <a href={portalSignIn} className={cn(buttonVariants({ variant: "ghost", size: "md" }))}>
            Client login
          </a>
          <Link href={href("/contact")} className={cn(buttonVariants({ variant: "primary", size: "md" }))}>
            Talk to us
          </Link>
        </div>

        <details className="site-menu ml-auto md:hidden">
          <summary
            className={cn(buttonVariants({ variant: "secondary", size: "md" }), "cursor-pointer")}
            aria-label="Open menu"
          >
            <Menu aria-hidden className="menu-closed" />
            <X aria-hidden className="menu-open" />
            Menu
          </summary>
          <div className="absolute inset-x-0 top-full border-b bg-card shadow-sm">
            <ul className="mx-auto flex w-full max-w-6xl flex-col px-4 py-2 sm:px-6">
              {items.map((item) => (
                <li key={item.path}>
                  <Link href={item.href} className="block rounded-md px-3 py-3 text-base font-medium hover:bg-muted">
                    {item.label}
                  </Link>
                </li>
              ))}
              <li className="mt-2 flex flex-col gap-2 border-t pt-3 pb-2">
                <Link href={href("/contact")} className={cn(buttonVariants({ variant: "primary", size: "lg" }), "w-full")}>
                  Talk to us
                </Link>
                <a href={portalSignIn} className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "w-full")}>
                  Client login
                </a>
              </li>
            </ul>
          </div>
        </details>
      </div>
    </header>
  );
}
