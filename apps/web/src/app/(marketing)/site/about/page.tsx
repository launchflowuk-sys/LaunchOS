import type { Metadata } from "next";
import { marketingLinks } from "@/lib/marketing/links";
import { LOCATION } from "@/lib/marketing/site";
import { Block, Container, CtaBand } from "../_components/primitives";

export const metadata: Metadata = {
  title: "About",
  description:
    "LaunchFlow is Shoji: a trained computer engineer in Grays, Essex, fifteen years building websites, now building and hosting the software his own businesses run on.",
  alternates: { canonical: "/about" },
  openGraph: { title: "About LaunchFlow", description: "One engineer, fifteen years, everything built and hosted in-house.", url: "/about" },
};

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
      <Container className="pt-14 pb-10 sm:pt-20 sm:pb-14">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
          <div>
            <h1 className="display text-4xl sm:text-5xl">Built by someone who runs the businesses too.</h1>
            <div className="mt-8 space-y-5 text-base leading-relaxed sm:text-lg">
              <p>
                LaunchFlow is Shoji. Trained computer engineer, fifteen years building websites for local businesses, and an
                owner-driver who got fed up with the dispatch software his own taxi firm was paying for — so he built one.
                Grays CabLine now runs on it, and so do other operators.
              </p>
              <p>
                That is the pattern for everything here. We build what we need to run a taxi company, a computer repair
                business, a tuition academy, a takeaway and an education consultancy, then offer the same thing to other
                local businesses. Every app we ship carries “Powered by LaunchFlow” in the footer, and every one of them is
                hosted on our own servers.
              </p>
              <p>
                We work from {LOCATION}, with clients across Thurrock, Essex and London, and a few further afield. Our
                local masjid&rsquo;s website and admin system was built here too, free, because it needed doing.
              </p>
            </div>
          </div>

          <aside className="rounded-2xl border bg-background p-6 sm:p-8 lg:mt-3">
            <h2 className="label-caps text-muted-foreground">In numbers</h2>
            <dl className="mt-4 divide-y">
              {[
                ["15 years", "building websites"],
                ["8 products", "of our own, live"],
                ["2 app stores", "iOS and Android"],
                ["1 place", "for support, plans and invoices"],
              ].map(([figure, label]) => (
                <div key={figure} className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="display text-2xl tabular-nums" data-numeric>
                    {figure}
                  </dt>
                  <dd className="text-right text-sm text-muted-foreground">{label}</dd>
                </div>
              ))}
            </dl>
          </aside>
        </div>
      </Container>

      <Block title="How we work" className="border-t bg-background">
        <div className="grid gap-8 sm:grid-cols-2">
          {PRINCIPLES.map((item) => (
            <div key={item.title}>
              <h3 className="text-lg font-semibold">{item.title}</h3>
              <p className="mt-2 text-muted-foreground">{item.body}</p>
            </div>
          ))}
        </div>
      </Block>

      <CtaBand
        title="Want to see it before you talk to us?"
        lede="The work page has screenshots and a brief for every project, and the products page has the things we run ourselves."
        primary={{ label: "See our work", href: href("/work") }}
        secondary={{ label: "Talk to us", href: href("/contact") }}
      />
    </>
  );
}
