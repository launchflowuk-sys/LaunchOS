import type { Metadata } from "next";
import { marketingLinks } from "@/lib/marketing/links";
import { SITE_DESCRIPTION } from "@/lib/marketing/site";
import { CtaBlock } from "./_components/cta-block";
import { About } from "./_components/home/about";
import { Hero } from "./_components/home/hero";
import { Products } from "./_components/home/products";
import { SelectedWork } from "./_components/home/selected-work";
import { Services } from "./_components/home/services";
import { Stats } from "./_components/home/stats";
import { Lines } from "./_components/primitives";

const TITLE = "LaunchFlow — Built to work. Designed to stand out.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { title: TITLE, description: SITE_DESCRIPTION, url: "/" },
};

/** The eight sections of the home page, in the order the reference reads them. */
export default async function HomePage() {
  const { href } = await marketingLinks();

  return (
    <>
      <Hero contactHref={href("/contact")} workHref={href("/work")} />
      <Stats />
      <SelectedWork href={href} />
      <Services contactHref={href("/contact")} />
      <Products href={href} />
      <About aboutHref={href("/about")} pricingHref={href("/pricing")} />
      <div className="pt-20 sm:pt-28">
        <CtaBlock
          title={<Lines first="Let's make" second="your next move." />}
          body="Tell us about the business and the problem. We will tell you the smallest thing that fixes it, and what it costs."
          primary={{ label: "Tell us about your project", href: href("/contact") }}
        />
      </div>
    </>
  );
}
