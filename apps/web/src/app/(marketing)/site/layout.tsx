import type { Metadata } from "next";
import { AttributionCapture } from "@/components/attribution-capture";
import { appHost, marketingHost } from "@/lib/env";
import { marketingLinks } from "@/lib/marketing/links";
import { OG_IMAGE, SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from "@/lib/marketing/site";
import { MenuDismiss } from "./_components/menu-dismiss";
import { SiteFooter } from "./_components/site-footer";
import { SiteHeader } from "./_components/site-header";
import "./marketing.css";
import "./motion.css";

/**
 * The public site's frame. It sits at `(marketing)/site/layout.tsx` rather
 * than at the group root for the reason the portal gives: Next types a
 * layout by its route, and the group root would be `LayoutProps<"/">`, the
 * key the admin shell already owns.
 *
 * Metadata is generated rather than static because the canonical origin is
 * always the marketing host while the page may be served on the app host
 * (`os.launchflow.co.uk/site/...`) for review. There, every page says
 * `noindex` so a search engine never files the duplicate.
 */
export async function generateMetadata(): Promise<Metadata> {
  const links = await marketingLinks();
  return {
    metadataBase: new URL(links.canonicalBase),
    title: { default: `${SITE_NAME} — ${SITE_TAGLINE}`, template: `%s — ${SITE_NAME}` },
    description: SITE_DESCRIPTION,
    openGraph: { siteName: SITE_NAME, type: "website", locale: "en_GB", images: [OG_IMAGE] },
    robots: links.onMarketingHost ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function MarketingLayout({ children }: LayoutProps<"/site">) {
  return (
    <div id="top" className="marketing flex min-h-screen flex-1 flex-col">
      {/* Scroll reveals start hidden and are shown by `motion-root.tsx`; a page
          with no script must still read. */}
      <noscript>
        <style>{`.marketing [data-reveal]{opacity:1;transform:none}`}</style>
      </noscript>
      {/* The campaign cookie: written once, on the first page a paid or
          referred visitor lands on, and read back by the contact form. */}
      <AttributionCapture ownHosts={[marketingHost(), appHost()]} />
      {/* The mobile menu is a native `<details>`, so it opens without a
          script — but `open` is DOM state and this layout survives a
          client-side navigation, which left the menu covering the page it had
          just opened. */}
      <MenuDismiss />
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
