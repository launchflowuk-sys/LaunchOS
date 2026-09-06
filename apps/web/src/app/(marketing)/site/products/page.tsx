import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { marketingLinks } from "@/lib/marketing/links";
import { PRODUCTS } from "@/lib/marketing/products";
import { STATUS_LABEL } from "@/lib/marketing/work";
import { CtaBand, LinkButton, PageIntro, Tag } from "../_components/primitives";
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
      <PageIntro
        title="Our own products."
        lede="We started building these because we needed them in our own businesses. Each one is live, hosted on our servers, and available to other operators."
      />

      <div className="border-t">
        {PRODUCTS.map((product, index) => {
          const flip = index % 2 === 1;
          return (
            <section key={product.slug} id={product.slug} className={flip ? "bg-background" : undefined} aria-labelledby={`${product.slug}-title`}>
              <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-2 lg:items-center lg:gap-14">
                <div className={flip ? "lg:order-2" : undefined}>
                  <div className="flex flex-wrap items-center gap-2">
                    {product.status !== "live" ? <Tag>{STATUS_LABEL[product.status]}</Tag> : <Tag className="border-success-border bg-success-bg text-success-fg">Live</Tag>}
                  </div>
                  <h2 id={`${product.slug}-title`} className="display mt-3 text-2xl sm:text-3xl">
                    {product.name}
                  </h2>
                  <p className="mt-2 text-lg font-medium text-muted-foreground">{product.tagline}</p>
                  <p className="mt-4 text-base leading-relaxed">{product.description}</p>
                  <ul className="mt-5 grid gap-2 sm:grid-cols-2">
                    {product.facts.map((fact) => (
                      <li key={fact} className="flex items-start gap-2 text-sm">
                        <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                        <span>{fact}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-6">
                    <LinkButton href={product.url} external variant="secondary" size="md">
                      {product.domain}
                      <ExternalLink aria-hidden />
                    </LinkButton>
                  </div>
                </div>
                <div className={flip ? "lg:order-1" : undefined}>
                  <Shot src={product.screenshots.desktop} alt={`${product.name} website`} name={product.name} priority={index === 0} />
                </div>
              </div>
            </section>
          );
        })}
      </div>

      <CtaBand
        title="Want one of these for your business?"
        lede="Most of them are a subscription. Tell us which one and we will get you set up, or build you the thing that is missing."
        primary={{ label: "Talk to us", href: href("/contact") }}
        secondary={{ label: "See pricing", href: href("/pricing") }}
      />
    </>
  );
}
