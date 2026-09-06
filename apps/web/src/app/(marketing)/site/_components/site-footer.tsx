import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { marketingLinks } from "@/lib/marketing/links";
import { CONTACT_EMAIL, FOOTER_LINE, LOCATION } from "@/lib/marketing/site";
import { Arrow, Container } from "./primitives";

const COLUMNS = [
  [
    { label: "Our work", path: "/work" },
    { label: "Our products", path: "/products" },
    { label: "Pricing", path: "/pricing" },
  ],
  [
    { label: "What we do", path: "/services" },
    { label: "About us", path: "/about" },
    { label: "Get in touch", path: "/contact" },
  ],
] as const;

export async function SiteFooter() {
  const { href, portalSignIn } = await marketingLinks();
  const year = new Date().getFullYear();

  return (
    <footer className="hairline bg-white">
      <Container className="py-14 sm:py-16">
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <BrandMark width={132} />
            <p className="lede mt-5 max-w-[30ch]">{FOOTER_LINE}</p>
          </div>

          {COLUMNS.map((column, index) => (
            <nav key={index} aria-label={index === 0 ? "Explore" : "Company"} className="lg:col-span-2">
              <ul className="space-y-3">
                {column.map((item) => (
                  <li key={item.path}>
                    <Link href={href(item.path)} className="tlink tlink-quiet text-[0.9375rem]">
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}

          <div className="space-y-3 text-[0.9375rem] lg:col-span-3">
            <p>
              <a href={`mailto:${CONTACT_EMAIL}`} className="tlink">
                {CONTACT_EMAIL}
              </a>
            </p>
            <p className="muted">{LOCATION}, United Kingdom</p>
            <p>
              <a href={portalSignIn} className="tlink">
                Client portal
                <Arrow />
              </a>
            </p>
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-[var(--line)] pt-6 text-sm text-[var(--mute)] sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} LaunchFlow
            <span aria-hidden className="mx-2">
              ·
            </span>
            <Link href={href("/privacy")} className="hover:text-[var(--ink)]">
              Privacy policy
            </Link>
          </p>
          <a href="#top" className="tlink tlink-quiet text-sm">
            Back to top
            <Arrow />
          </a>
        </div>
      </Container>
    </footer>
  );
}
