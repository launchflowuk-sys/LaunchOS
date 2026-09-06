import type { Metadata } from "next";
import { marketingLinks } from "@/lib/marketing/links";
import { PRODUCTS } from "@/lib/marketing/products";
import { STATUS_LABEL } from "@/lib/marketing/work";
import { CtaBlock } from "../_components/cta-block";
import { Btn, Container, Lines, Pill, SectionHead } from "../_components/primitives";
import { Shot } from "../_components/shot";

export const metadata: Metadata = {
  title: "Products",
  description:
    "Cabio taxi dispatch, Agent Zero phone agent, Lima inbox agent, BizzFlow for the trades, LaunchOS, Funnel Engine, takeaway ordering and YourNanny — the products LaunchFlow builds and runs.",
  alternates: { canonical: "/products" },
  openGraph: { title: "Products — LaunchFlow", description: "The systems we run our own businesses on, and sell to others.", url: "/products" },
};

export default async function ProductsPage() {
  const { href } = await marketingLinks();

  return (
    <>
      <Container className="pt-14 pb-16 sm:pt-20 sm:pb-20">
        <SectionHead
          level={1}
          index="03"
          eyebrow="Made by LaunchFlow"
          title={<Lines first="We're builders." second="And business owners." />}
          aside="We started building these because we needed them in our own businesses. Each one is hosted on our servers, and available to other operators."
        />
      </Container>

      <div className="hairline">
        {PRODUCTS.map((product, index) => {
          const flip = index % 2 === 1;
          return (
            <section key={product.slug} id={product.slug} className={flip ? "section-off" : undefined} aria-labelledby={`${product.slug}-title`}>
              <Container className="grid gap-10 py-16 sm:py-20 lg:grid-cols-12 lg:items-center lg:gap-16">
                <div className={flip ? "lg:col-span-6 lg:order-2" : "lg:col-span-6"} data-reveal>
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="eyebrow">{product.category}</p>
                    <Pill tone={product.status === "live" ? "live" : "default"}>{STATUS_LABEL[product.status]}</Pill>
                  </div>
                  <h2 id={`${product.slug}-title`} className="h-section mt-5">
                    {product.name}
                  </h2>
                  <p className="mt-3 text-lg font-medium text-[var(--mute-2)]">{product.tagline}</p>
                  <p className="body mt-5 max-w-[56ch] leading-relaxed">{product.description}</p>
                  <ul className="mt-6 flex flex-wrap gap-2">
                    {product.facts.map((fact) => (
                      <li key={fact} className="chip">
                        {fact}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-8">
                    <Btn href={product.url} external tone="white">
                      {product.domain}
                    </Btn>
                  </div>
                </div>
                <div className={flip ? "lg:col-span-6 lg:order-1" : "lg:col-span-6"} data-reveal>
                  <a href={product.url} rel="noopener" className="tilt block rounded-2xl" aria-label={`${product.name} at ${product.domain}`}>
                    <Shot src={product.screenshots.desktop} alt={`${product.name} website`} name={product.name} priority={index === 0} chip inner />
                  </a>
                </div>
              </Container>
            </section>
          );
        })}
      </div>

      <div className="pt-20 sm:pt-28">
        <CtaBlock
          title={<Lines first="Want one of these" second="for your business?" />}
          body="Most of them are a subscription. Tell us which one and we will get you set up, or build you the thing that is missing."
          primary={{ label: "Tell us what you need", href: href("/contact") }}
        />
      </div>
    </>
  );
}
