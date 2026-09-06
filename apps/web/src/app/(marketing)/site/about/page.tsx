import type { Metadata } from "next";
import { marketingLinks } from "@/lib/marketing/links";
import { LOCATION } from "@/lib/marketing/site";
import { CtaBlock } from "../_components/cta-block";
import { PATH } from "../_components/home/about";
import { Container, Lines, SectionHead } from "../_components/primitives";

export const metadata: Metadata = {
  title: "About",
  description:
    "LaunchFlow is Shoji: a trained computer engineer in Grays, Essex, fifteen years building websites, now building and hosting the software his own businesses run on.",
  alternates: { canonical: "/about" },
  openGraph: { title: "About LaunchFlow", description: "One engineer, fifteen years, everything built and hosted in-house.", url: "/about" },
};

const NUMBERS = [
  { value: 15, pad: 2, unit: "years", label: "building for local businesses" },
  { value: 8, pad: 2, unit: "products", label: "of our own, live or in build" },
  { value: 2, pad: 2, unit: "app stores", label: "iOS and Android" },
  { value: 1, pad: 2, unit: "portal", label: "for support, plans and invoices" },
] as const;

const PRINCIPLES = [
  {
    title: "We use what we build",
    body: "Our taxi company dispatches on our own platform. Our support runs through our own portal. If something is annoying, we feel it before you do and fix it.",
  },
  {
    title: "Everything in-house",
    body: "Design, code, servers, DNS, monitoring, ads. No subcontractors, no agency-of-agencies, no waiting three days for someone else's ticket.",
  },
  {
    title: "Our own servers",
    body: "Every site and app we ship runs on our Hetzner servers, deployed through Coolify, backed up nightly and watched by our own uptime monitor.",
  },
  {
    title: "Plain dealing",
    body: "A monthly invoice you can read, a portal that shows what we are doing, and a straight answer when something is not worth building.",
  },
] as const;

export default async function AboutPage() {
  const { href } = await marketingLinks();

  return (
    <>
      <Container className="pt-14 sm:pt-20">
        <SectionHead level={1} index="04" eyebrow="A different kind of studio" title={<Lines first="We know what it takes." second="We run businesses too." secondClass="quiet" />} />
      </Container>

      <Container className="py-14 sm:py-20">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="space-y-6 text-[1.0625rem] leading-relaxed lg:col-span-7" data-reveal>
            <p>
              LaunchFlow is Shoji. Trained computer engineer, fifteen years building websites for local businesses, and an owner-driver who got fed up with
              the dispatch software his own taxi firm was paying for — so he built one. Grays CabLine now runs on it, and so do other operators.
            </p>
            <p className="body">
              That is the pattern for everything here. We build what we need to run a taxi company, a computer repair business, a tuition academy, a
              takeaway and an education consultancy, then offer the same thing to other local businesses. Every app we ship carries &ldquo;Powered by
              LaunchFlow&rdquo; in the footer, and every one of them is hosted on our own servers.
            </p>
            <p className="body">
              We work from {LOCATION}, with clients across Thurrock, Essex and London, and a few further afield. Our local masjid&rsquo;s website and
              admin system was built here too, free, because it needed doing.
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-8 self-start lg:col-span-5">
            {NUMBERS.map((stat) => (
              <div key={stat.unit} className="border-t border-[var(--line)] pt-4" data-reveal>
                <dt className="sr-only">{stat.label}</dt>
                <dd className="flex items-baseline gap-1.5">
                  <span className="figure text-[2.5rem] sm:text-[3rem]" data-count={stat.value} data-pad={stat.pad}>
                    {String(stat.value).padStart(stat.pad, "0")}
                  </span>
                  <span className="text-[var(--mute)]">{stat.unit}</span>
                </dd>
                <dd className="body mt-1 text-sm" aria-hidden>
                  {stat.label}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Container>

      <section className="section-off" aria-labelledby="principles-title">
        <Container className="py-20 sm:py-24">
          <h2 id="principles-title" className="h-section max-w-[16ch]" data-reveal>
            How we work.
          </h2>
          <div className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2">
            {PRINCIPLES.map((item) => (
              <div key={item.title} className="border-t border-[#cfd7e1] pt-5" data-reveal>
                <h3 className="h-card">{item.title}</h3>
                <p className="body mt-3">{item.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-20">
            <h2 className="h-sub max-w-[20ch]" data-reveal>
              A clear path from idea to launch.
            </h2>
            <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {PATH.map((step, index) => (
                <li key={step.name} className="border-t border-[#cfd7e1] pt-5" data-reveal>
                  <p className="eyebrow eyebrow-index">
                    <b>{String(index + 1).padStart(2, "0")}</b>
                  </p>
                  <p className="h-card mt-3">{step.name}</p>
                  <p className="body mt-2 text-[0.9375rem]">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </Container>
      </section>

      <div className="pt-20 sm:pt-28">
        <CtaBlock
          title={<Lines first="See it before" second="you talk to us." />}
          body="The work page has screenshots and a brief for every project, and the products page has the things we run ourselves. Or just say hello."
          primary={{ label: "Say hello", href: href("/contact") }}
        />
      </div>
    </>
  );
}
