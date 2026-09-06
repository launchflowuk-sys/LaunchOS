import type { Metadata } from "next";
import { Check } from "lucide-react";
import Link from "next/link";
import { marketingLinks } from "@/lib/marketing/links";
import { pricingPackages } from "@/lib/marketing/packages";
import { CtaBlock } from "../_components/cta-block";
import { Btn, Container, Lines, Pill, SectionHead } from "../_components/primitives";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Monthly plans for hosting, care, SEO and content, with a plain invoice you can cancel any time. Custom builds are quoted.",
  alternates: { canonical: "/pricing" },
  openGraph: { title: "Pricing — LaunchFlow", description: "Monthly plans with a plain invoice. Custom work is quoted.", url: "/pricing" },
};

const QUESTIONS = [
  {
    q: "Is there a contract?",
    a: "Monthly, cancel any time from your portal. If you leave, your domain and your content are yours and we help you move them.",
  },
  {
    q: "What does the set-up fee cover?",
    a: "Building the site or moving an existing one onto our servers, setting up monitoring, backups, email and Google Business Profile, and the first month's content.",
  },
  {
    q: "What if I need a web app or a mobile app?",
    a: "Those are quoted per project after a short call, and usually run on one of the plans above once they are live so the hosting, support and updates are covered.",
  },
  {
    q: "How do I pay?",
    a: "By card through Stripe when you sign up, then a monthly invoice you can see and pay in your portal. VAT invoices, no surprises.",
  },
] as const;

/** Plans from the database, cheapest first; the fullest is the one with the ink button. */
export default async function PricingPage() {
  const [{ href, signup }, packages] = await Promise.all([marketingLinks(), pricingPackages()]);
  const recommended = packages.length > 1 ? packages.length - 1 : -1;

  return (
    <>
      <Container className="pt-14 pb-14 sm:pt-20 sm:pb-16">
        <SectionHead
          level={1}
          eyebrow="A plan that fits"
          title={<Lines first="Simple monthly care." second="Custom builds, clearly quoted." secondClass="quiet" />}
          aside="Pick a plan, sign up in two minutes, and your portal login arrives by email. Bigger builds are quoted after a short call."
        />
      </Container>

      <Container className="pb-16 sm:pb-20">
        {packages.length === 0 ? (
          <div className="card p-8 text-center" data-reveal>
            <p className="h-card">Plans are being updated.</p>
            <p className="body mt-2">
              <Link href={href("/contact")} className="link-blue">
                Talk to us
              </Link>{" "}
              and we will set you up by hand.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {packages.map((pkg, index) => {
              const isRecommended = index === recommended;
              return (
                <article key={pkg.slug} className={isRecommended ? "card flex flex-col border-[var(--ink)] p-6 sm:p-9" : "card flex flex-col p-6 sm:p-9"} data-reveal>
                  <div className="flex items-start justify-between gap-4">
                    <h2 className="h-sub">{pkg.name}</h2>
                    {isRecommended ? <Pill tone="tint">Most complete</Pill> : null}
                  </div>
                  {pkg.description ? <p className="body mt-3">{pkg.description}</p> : null}
                  <p className="mt-8 flex items-baseline gap-2">
                    <span className="figure" data-numeric>
                      {pkg.monthlyPrice}
                    </span>
                    <span className="text-[var(--mute)]">a month</span>
                  </p>
                  <p className="mt-2 text-sm text-[var(--mute)]">{pkg.setupPrice ? `${pkg.setupPrice} set-up, once.` : "No set-up fee."} Prices exclude VAT.</p>
                  <ul className="mt-8 flex-1 space-y-3 border-t border-[var(--line)] pt-8">
                    {pkg.includes.map((line) => (
                      <li key={line} className="flex items-start gap-3 text-[0.9375rem]">
                        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[var(--tint)] text-[var(--blue)]">
                          <Check aria-hidden className="size-3" strokeWidth={3} />
                        </span>
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-10">
                    <Btn href={signup(pkg.slug)} external tone={isRecommended ? "ink" : "white"} size="lg" className="btn-block" ariaLabel={`Get started with ${pkg.name}`}>
                      Get started
                    </Btn>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <div className="mt-8 flex flex-col gap-6 rounded-2xl border border-[var(--line)] bg-[var(--off)] px-6 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8" data-reveal>
          <div>
            <p className="h-card">Need something custom?</p>
            <p className="body mt-1">A booking system, a dispatch platform, an app on the stores. Tell us the problem and we will quote it.</p>
          </div>
          <Btn href={href("/contact")} tone="white" className="shrink-0">
            Let&rsquo;s talk
          </Btn>
        </div>
      </Container>

      <section className="section-off" aria-labelledby="faq-title">
        <Container className="grid gap-10 py-20 sm:py-24 lg:grid-cols-12">
          <h2 id="faq-title" className="h-section lg:col-span-5" data-reveal>
            <Lines first="Questions" second="people ask." secondClass="quiet" />
          </h2>
          <div className="border-t border-[#cfd7e1] lg:col-span-7">
            {QUESTIONS.map((item) => (
              <details key={item.q} className="faq group border-b border-[#cfd7e1]" data-reveal>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[1.0625rem] font-medium [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full border border-[#cfd7e1] transition-transform duration-300 group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="body max-w-[60ch] pb-6">{item.a}</p>
              </details>
            ))}
          </div>
        </Container>
      </section>

      <div className="pt-20 sm:pt-28">
        <CtaBlock
          title={<Lines first="Ready when" second="you are." />}
          body="Sign up now and your portal is live in minutes, or ask us anything first."
          primary={{ label: "Ask us anything", href: href("/contact") }}
        />
      </div>
    </>
  );
}
