import { FLAGSHIP_PRODUCTS, UPCOMING_PRODUCTS } from "@/lib/marketing/products";
import { STATUS_LABEL } from "@/lib/marketing/work";
import { Arrow, Container, Lines, Pill, SectionHead } from "../primitives";

/** 03 / MADE BY LAUNCHFLOW — the four flagship products, then the four taking shape. */
export function Products({ href }: { href: (path: string) => string }) {
  return (
    <section aria-labelledby="products-title" className="py-20 sm:py-28">
      <Container>
        <SectionHead
          id="products-title"
          index="03"
          eyebrow="Made by LaunchFlow"
          title={<Lines first="We're builders." second="And business owners." />}
          aside="Our own challenges become our next products. Everything here started as something we needed in a business we run, and got good enough to sell."
          link={{ label: "Meet the products", href: href("/products") }}
        />

        <ul className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2 lg:grid-cols-4">
          {FLAGSHIP_PRODUCTS.map((product) => (
            <li key={product.slug} className="group flex flex-col bg-white p-6 transition-colors hover:bg-[var(--fill)]" data-reveal>
              <div className="flex items-center justify-between gap-3">
                <p className="eyebrow">{product.category}</p>
                <Pill tone={product.status === "live" ? "live" : "default"}>{STATUS_LABEL[product.status]}</Pill>
              </div>
              <h3 className="h-card mt-6">{product.name}</h3>
              <p className="mt-1 text-[0.9375rem] font-medium text-[var(--mute-2)]">{product.tagline}</p>
              <p className="body mt-3 flex-1 text-[0.9375rem]">{product.oneLine}</p>
              <a href={product.url} rel="noopener" className="tlink mt-6 text-sm">
                {product.domain}
                <Arrow />
              </a>
            </li>
          ))}
        </ul>

        <div className="mt-14 grid gap-8 lg:grid-cols-12">
          <p className="eyebrow eyebrow-index lg:col-span-3" data-reveal>
            <span>Also taking shape</span>
          </p>
          <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:col-span-9 lg:grid-cols-4">
            {UPCOMING_PRODUCTS.map((product) => (
              <li key={product.slug} className="border-t border-[var(--line)] pt-4" data-reveal>
                <p className="h-line">{product.name}</p>
                <p className="body mt-1 text-sm">{product.tagline}</p>
                <p className="mt-2 text-xs font-medium tracking-wide text-[var(--mute)] uppercase">{STATUS_LABEL[product.status]}</p>
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}
