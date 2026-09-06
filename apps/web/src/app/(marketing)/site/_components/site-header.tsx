import { Menu, X } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { marketingLinks } from "@/lib/marketing/links";
import { NAV } from "@/lib/marketing/site";
import { Arrow, Btn } from "./primitives";

/**
 * 64px, white, sticky under a hairline. The wordmark left, five links in
 * the centre with an underline that slides in from the left, "Client login"
 * and the "Let's talk" pill on the right. Under `md` the links fold into a
 * native `<details>` so the menu works with no client JavaScript at all —
 * a marketing page must be usable the instant its HTML arrives.
 */
export async function SiteHeader() {
  const { href, portalSignIn } = await marketingLinks();
  const items = NAV.map((item) => ({ ...item, href: href(item.path) }));

  return (
    <header className="site-header">
      <div className="mx-auto grid h-16 w-full max-w-[76rem] grid-cols-[1fr_auto] items-center px-5 sm:px-8 md:grid-cols-[1fr_auto_1fr]">
        <Link href={href("/")} className="inline-flex shrink-0 rounded-md" aria-label="LaunchFlow home">
          <BrandMark width={124} priority />
        </Link>

        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-7">
            {items.map((item) => (
              <li key={item.path}>
                <Link href={item.href} className="nav-link">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden items-center justify-end gap-5 md:flex">
          <a href={portalSignIn} className="text-[0.9375rem] font-medium text-[var(--mute)] transition-colors hover:text-[var(--ink)]">
            Client login
          </a>
          <Btn href={href("/contact")} tone="ink">
            Let&rsquo;s talk
          </Btn>
        </div>

        <details className="site-menu justify-self-end md:hidden">
          <summary className="btn btn-white cursor-pointer" aria-label="Open menu">
            <Menu aria-hidden className="menu-closed size-4" />
            <X aria-hidden className="menu-open size-4" />
            Menu
          </summary>
          <div className="absolute inset-x-0 top-full border-b border-[var(--line)] bg-white shadow-sm">
            <ul className="mx-auto flex w-full max-w-[76rem] flex-col px-5 py-3 sm:px-8">
              {items.map((item) => (
                <li key={item.path}>
                  <Link href={item.href} className="flex items-center justify-between rounded-lg px-2 py-3 text-lg font-medium hover:bg-[var(--off)]">
                    {item.label}
                    <Arrow className="text-[var(--mute)]" />
                  </Link>
                </li>
              ))}
              <li className="mt-2 flex flex-col gap-2 border-t border-[var(--line)] pt-4 pb-2">
                <Btn href={href("/contact")} tone="ink" className="btn-block">
                  Let&rsquo;s talk
                </Btn>
                <a href={portalSignIn} className="btn btn-white btn-block">
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
