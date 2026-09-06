import { Btn, Container, Eyebrow, Lines, TextLink } from "../primitives";

export const PATH = [
  { name: "Let's talk", body: "A short call and a written plan with a price. If we are not the right fit, we say so." },
  { name: "Make it real", body: "Design and code by the same hands, on a private link you see early and often." },
  { name: "Go live", body: "Domain, email, search and tracking set up properly. Live on our servers, backed up from day one." },
  { name: "Keep growing", body: "Support portal, monthly content, uptime checks and patching. Your site keeps earning." },
] as const;

/** 04 / A DIFFERENT KIND OF STUDIO — on off-white: who we are, the four-step path, the plan strip. */
export function About({ aboutHref, pricingHref }: { aboutHref: string; pricingHref: string }) {
  return (
    <section aria-labelledby="about-title" className="section-off">
      <Container className="py-20 sm:py-28">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-7 lg:col-start-6 lg:text-right" data-reveal>
            <Eyebrow index="04">A different kind of studio</Eyebrow>
            <h2 id="about-title" className="h-section mt-5">
              <Lines first="We know what it takes." second="We run businesses too." secondClass="quiet" />
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-1 lg:row-start-2" data-reveal>
            <p className="lede">
              LaunchFlow is Shoji: a trained computer engineer, fifteen years building for local businesses, and the owner of a taxi firm, a repair shop
              and more. The dispatch platform, the phone agent, the client portal — we use the systems we build every day, long before we ask anyone
              else to.
            </p>
            <div className="mt-6">
              <TextLink href={aboutHref}>The story behind LaunchFlow</TextLink>
            </div>
          </div>
        </div>

        <div className="mt-20 sm:mt-24">
          <h3 className="h-sub max-w-[20ch]" data-reveal>
            A clear path from idea to launch.
          </h3>
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

        <div className="mt-16 flex flex-col gap-6 rounded-2xl border border-[#cfd7e1] bg-white px-6 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8" data-reveal>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <p className="eyebrow">A plan that fits</p>
            <p className="h-line">Simple monthly care. Custom builds, clearly quoted.</p>
          </div>
          <Btn href={pricingHref} tone="white" className="shrink-0">
            Explore pricing
          </Btn>
        </div>
      </Container>
    </section>
  );
}
