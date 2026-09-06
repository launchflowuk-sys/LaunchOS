import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { marketingLinks } from "@/lib/marketing/links";
import { PRODUCTS } from "@/lib/marketing/products";
import { LOCATION, SITE_DESCRIPTION, SITE_TAGLINE } from "@/lib/marketing/site";
import { FEATURED_WORK } from "@/lib/marketing/work";
import { Block, Container, CtaBand, LinkButton } from "./_components/primitives";
import { WorkCard } from "./_components/work-card";

export const metadata: Metadata = {
  title: { absolute: `LaunchFlow — ${SITE_TAGLINE}` },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { title: `LaunchFlow — ${SITE_TAGLINE}`, description: SITE_DESCRIPTION, url: "/" },
};

const PROOF = [
  { figure: "8", label: "products of our own, live and earning", detail: "A taxi dispatch platform, a phone agent, an inbox agent, a trades platform and more." },
  { figure: "Monthly", label: "clients on subscription, not one-off builds", detail: "Hosting, care, content and support on a plain invoice, cancel any time." },
  { figure: "100%", label: "hosted on our own servers", detail: "Every site and app on our Hetzner servers, monitored every few minutes." },
] as const;

const STEPS = [
  { name: "Brief", body: "A call, a few questions, and a written plan with a price. If we are not the right fit, we say so." },
  { name: "Build", body: "You see it early and often on a private link. Design and code by the same person, so nothing is lost in handover." },
  { name: "Launch", body: "Domain, DNS, email, search set-up and tracking done properly. Live on our servers with backups from day one." },
  { name: "Look after", body: "Support portal, monthly content, uptime checks and patching. Your site keeps earning after launch." },
] as const;

export default async function HomePage() {
  const { href } = await marketingLinks();

  return (
    <>
      {/* Hero: one statement, one line of context, two actions. */}
      <Container className="pt-16 pb-14 sm:pt-24 sm:pb-20">
        <p className="text-sm font-medium text-muted-foreground">LaunchFlow · {LOCATION}</p>
        <h1 className="display mt-4 max-w-4xl text-4xl sm:text-5xl lg:text-6xl">{SITE_TAGLINE}</h1>
        <p className="lede mt-6 max-w-2xl text-lg text-muted-foreground sm:text-xl">
          Fifteen years of building websites for local businesses. Now full-stack web apps, mobile apps, hosting, design and ad
          management — plus our own products, which we run every day.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <LinkButton href={href("/contact")}>Talk to us</LinkButton>
          <LinkButton href={href("/work")} variant="secondary">
            See our work
          </LinkButton>
        </div>
      </Container>

      {/* Proof: three facts, no adjectives. */}
      <section className="border-y bg-background" aria-label="Why LaunchFlow">
        <Container className="grid gap-8 py-10 sm:grid-cols-3 sm:gap-6 sm:py-12">
          {PROOF.map((item) => (
            <div key={item.label}>
              <p className="display text-3xl text-primary sm:text-4xl" data-numeric>
                {item.figure}
              </p>
              <p className="mt-2 font-semibold">{item.label}</p>
              <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
            </div>
          ))}
        </Container>
      </section>

      <Block title="Recent work" lede="Real businesses, real systems, screenshots from the live sites.">
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-2">
          {FEATURED_WORK.map((item, index) => (
            <WorkCard key={item.slug} item={item} href={href(`/work/${item.slug}`)} priority={index === 0} />
          ))}
        </div>
        <div className="mt-10">
          <Link href={href("/work")} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
            All work
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      </Block>

      <Block title="Our own products" lede="We do not only build for clients. These are the systems we run our businesses on, and sell to others." className="border-t bg-background">
        <ul className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {PRODUCTS.map((product) => (
            <li key={product.slug} className="bg-card p-5">
              <p className="font-semibold">{product.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">{product.tagline}</p>
              <a href={product.url} rel="noopener" className="mt-3 inline-block text-meta font-medium text-primary hover:underline">
                {product.domain}
              </a>
            </li>
          ))}
        </ul>
        <div className="mt-8">
          <Link href={href("/products")} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
            About the products
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      </Block>

      <Block title="How we work" lede="Four steps. You always know which one you are on.">
        <ol className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.name} className="border-t-2 border-primary pt-4">
              <p className="text-meta font-semibold tabular-nums text-primary">{String(index + 1).padStart(2, "0")}</p>
              <h3 className="mt-1 text-lg font-semibold">{step.name}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </Block>

      <CtaBand
        title="Tell us what you need."
        lede="A couple of lines is enough. Shoji reads every message and replies within one working day."
        primary={{ label: "Talk to us", href: href("/contact") }}
        secondary={{ label: "See pricing", href: href("/pricing") }}
      />
    </>
  );
}
