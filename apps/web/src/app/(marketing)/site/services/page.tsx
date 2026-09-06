import type { Metadata } from "next";
import { marketingLinks } from "@/lib/marketing/links";
import { SERVICES } from "@/lib/marketing/services";
import { CtaBlock } from "../_components/cta-block";
import { Container, Lines, SectionHead } from "../_components/primitives";

export const metadata: Metadata = {
  title: "Services",
  description:
    "Web applications, mobile apps, websites and hosting, design, ad management, AI agents and ongoing care — from one team in Grays, Essex.",
  alternates: { canonical: "/services" },
  openGraph: { title: "Services — LaunchFlow", description: "Everything a local business needs online, built and looked after by one team.", url: "/services" },
};

export default async function ServicesPage() {
  const { href } = await marketingLinks();

  return (
    <>
      <Container className="pt-14 pb-16 sm:pt-20 sm:pb-20">
        <SectionHead
          level={1}
          index="02"
          eyebrow="What we do"
          title={<Lines first="Every piece." second="One partner." />}
          aside="From the first sketch to the servers it runs on. You deal with one person, and that person has built and hosted everything on this page."
        />
      </Container>

      <Container className="pb-20 sm:pb-28">
        <ol className="border-t border-[var(--line)]">
          {SERVICES.map((service, index) => (
            <li key={service.slug} id={service.slug} className="grid gap-6 border-b border-[var(--line)] py-12 sm:py-14 lg:grid-cols-12 lg:gap-12" data-reveal>
              <div className="lg:col-span-5">
                <p className="eyebrow eyebrow-index">
                  <b>{String(index + 1).padStart(2, "0")}</b>
                </p>
                <h2 className="h-sub mt-3">{service.name}</h2>
                <p className="lede mt-3">{service.summary}</p>
              </div>
              <div className="lg:col-span-7">
                <p className="body max-w-[60ch] text-[1.0625rem] leading-relaxed">{service.detail}</p>
                <ul className="mt-6 flex flex-wrap gap-2">
                  {service.points.map((point) => (
                    <li key={point} className="chip">
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ol>
      </Container>

      <CtaBlock
        title={<Lines first="Not sure which" second="of these you need?" />}
        body="Most people are not. Tell us the problem and we will tell you the smallest thing that fixes it."
        primary={{ label: "Tell us what you need", href: href("/contact") }}
      />
    </>
  );
}
