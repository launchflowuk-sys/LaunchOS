import { SiteFooter } from "../_components/site-footer";
import { SiteHeader } from "../_components/site-header";

/**
 * The marketing chrome: the sticky nav and the big footer.
 *
 * A route group rather than a flag, because exactly one page under `site/`
 * wants neither — `/start` draws its own minimal header with a Save & exit,
 * and stacking the marketing nav on top of it puts two LaunchFlow logos on the
 * screen at once. Route groups do not appear in the URL, so every page in here
 * keeps the address it had.
 */
export default function ChromeLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </>
  );
}
