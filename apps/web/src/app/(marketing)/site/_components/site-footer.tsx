import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { marketingLinks } from "@/lib/marketing/links";
import { PRODUCTS } from "@/lib/marketing/products";
import { CONTACT_EMAIL, CONTACT_PHONE, LOCATION, NAV } from "@/lib/marketing/site";

const COMPANY = [...NAV, { label: "Contact", path: "/contact" }, { label: "Privacy", path: "/privacy" }] as const;

export async function SiteFooter() {
  const { href, portalSignIn } = await marketingLinks();
  const year = new Date().getFullYear();

  return (
    <footer className="border-t bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <BrandMark width={128} />
            <p className="mt-4 max-w-xs text-sm text-muted-foreground">
              Web applications, mobile apps, websites and hosting for local businesses. Built and hosted in-house in {LOCATION}.
            </p>
          </div>

          <FooterList title="Company">
            {COMPANY.map((item) => (
              <li key={item.path}>
                <Link href={href(item.path)} className="hover:text-foreground hover:underline">
                  {item.label}
                </Link>
              </li>
            ))}
          </FooterList>

          <FooterList title="Products">
            {PRODUCTS.map((product) => (
              <li key={product.slug}>
                <a href={product.url} className="hover:text-foreground hover:underline" rel="noopener">
                  {product.name}
                </a>
              </li>
            ))}
          </FooterList>

          <FooterList title="Get in touch">
            <li>
              <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-foreground hover:underline">
                {CONTACT_EMAIL}
              </a>
            </li>
            {CONTACT_PHONE ? (
              <li>
                <a href={`tel:${CONTACT_PHONE.replace(/\s+/g, "")}`} className="hover:text-foreground hover:underline">
                  {CONTACT_PHONE}
                </a>
              </li>
            ) : null}
            <li>{LOCATION}</li>
            <li className="pt-2">
              <a href={portalSignIn} className="font-medium text-primary hover:underline">
                Client portal login
              </a>
            </li>
          </FooterList>
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t pt-6 text-meta text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} LaunchFlow. All rights reserved.</p>
          <p>Powered by LaunchFlow</p>
        </div>
      </div>
    </footer>
  );
}

function FooterList({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="label-caps text-muted-foreground">{title}</h2>
      <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">{children}</ul>
    </div>
  );
}
