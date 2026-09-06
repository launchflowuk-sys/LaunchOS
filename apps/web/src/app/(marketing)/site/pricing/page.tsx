import type { Metadata } from "next";
import { Check } from "lucide-react";
import Link from "next/link";
import { marketingLinks } from "@/lib/marketing/links";
import { pricingPackages } from "@/lib/marketing/packages";
import { Block, Container, CtaBand, LinkButton, PageIntro } from "../_components/primitives";

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

export default async function PricingPage() {
  const [{ href, signup }, packages] = await Promise.all([marketingLinks(), pricingPackages()]);

  return (
    <>
      <PageIntro
        title="Plain monthly pricing."
        lede="Pick a plan, sign up in two minutes, and your portal login arrives by email. Bigger builds are quoted after a short call."
      />

      <Container className="pb-12 sm:pb-16">
        {packages.length === 0 ? (
          <div className="rounded-xl border bg-background p-8 text-center">
            <p className="text-lg font-semibold">Plans are being updated.</p>
            <p className="mt-2 text-muted-foreground">
              <Link href={href("/contact")} className="font-medium text-primary hover:underline">
                Talk to us
              </Link>{" "}
              and we will set you up by hand.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {packages.map((pkg, index) => (
              <article
                key={pkg.slug}
                className={
                  index === packages.length - 1 && packages.length > 1
                    ? "flex flex-col rounded-2xl border-2 border-primary bg-card p-6 shadow-sm sm:p-8"
                    : "flex flex-col rounded-2xl border bg-card p-6 shadow-sm sm:p-8"
                }
              >
                <h2 className="text-xl font-semibold">{pkg.name}</h2>
                {pkg.description ? <p className="mt-2 text-muted-foreground">{pkg.description}</p> : null}
                <p className="mt-6 flex items-baseline gap-1.5">
                  <span className="display text-4xl tabular-nums" data-numeric>
                    {pkg.monthlyPrice}
                  </span>
                  <span className="text-muted-foreground">a month</span>
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {pkg.setupPrice ? `${pkg.setupPrice} set-up, once.` : "No set-up fee."} Prices exclude VAT.
                </p>
                <ul className="mt-6 space-y-2.5 border-t pt-6">
                  {pkg.includes.map((line) => (
                    <li key={line} className="flex items-start gap-2.5 text-sm">
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={2.25} />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-8 pt-2">
                  <LinkButton href={signup(pkg.slug)} external className="w-full">
                    Get started with {pkg.name}
                  </LinkButton>
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="mt-8 rounded-xl border bg-background p-6 sm:flex sm:items-center sm:justify-between sm:gap-6 sm:p-8">
          <div>
            <h2 className="text-xl font-semibold">Need something custom?</h2>
            <p className="mt-1 text-muted-foreground">
              A booking system, a dispatch platform, an app on the stores. Tell us the problem and we will quote it.
            </p>
          </div>
          <div className="mt-4 shrink-0 sm:mt-0">
            <LinkButton href={href("/contact")} variant="secondary" className="w-full sm:w-auto">
              Talk to us
            </LinkButton>
          </div>
        </div>
      </Container>

      <Block title="Questions people ask" className="border-t bg-background">
        <dl className="grid gap-x-12 gap-y-8 md:grid-cols-2">
          {QUESTIONS.map((item) => (
            <div key={item.q}>
              <dt className="text-base font-semibold">{item.q}</dt>
              <dd className="mt-2 text-muted-foreground">{item.a}</dd>
            </div>
          ))}
        </dl>
      </Block>

      <CtaBand
        title="Ready when you are."
        lede="Sign up now and your portal is live in minutes, or ask us anything first."
        primary={{ label: "Talk to us", href: href("/contact") }}
        secondary={{ label: "See our work", href: href("/work") }}
      />
    </>
  );
}
