import type { Metadata } from "next";
import { Check } from "lucide-react";
import { marketingLinks } from "@/lib/marketing/links";
import { SERVICES } from "@/lib/marketing/services";
import { CtaBand, PageIntro } from "../_components/primitives";

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
      <PageIntro
        title="One team for the whole job."
        lede="From the first sketch to the servers it runs on. You deal with one person, and that person has built and hosted everything on this page."
      />

      <div className="border-t">
        {SERVICES.map((service, index) => (
          <section
            key={service.slug}
            id={service.slug}
            className={index % 2 === 1 ? "bg-background" : undefined}
            aria-labelledby={`${service.slug}-title`}
          >
            <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12">
              <div>
                <p className="text-meta font-semibold tabular-nums text-primary">{String(index + 1).padStart(2, "0")}</p>
                <h2 id={`${service.slug}-title`} className="display mt-2 text-2xl sm:text-3xl">
                  {service.name}
                </h2>
                <p className="lede mt-3 text-base text-muted-foreground sm:text-lg">{service.summary}</p>
              </div>
              <div>
                <p className="text-base leading-relaxed">{service.detail}</p>
                <ul className="mt-6 grid gap-2.5 sm:grid-cols-2">
                  {service.points.map((point) => (
                    <li key={point} className="flex items-start gap-2.5 text-sm">
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={2.25} />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        ))}
      </div>

      <CtaBand
        title="Not sure which of these you need?"
        lede="Most people are not. Tell us the problem and we will tell you the smallest thing that fixes it."
        primary={{ label: "Talk to us", href: href("/contact") }}
        secondary={{ label: "See pricing", href: href("/pricing") }}
      />
    </>
  );
}
