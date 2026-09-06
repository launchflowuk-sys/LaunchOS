import { SERVICES } from "@/lib/marketing/services";
import { Accordion } from "../accordion";
import { Btn, Container, Eyebrow, Lines } from "../primitives";

/** 02 / WHAT WE DO — on the ink background, the seven services as an accordion. */
export function Services({ contactHref }: { contactHref: string }) {
  const items = SERVICES.map((service) => ({
    id: service.slug,
    title: service.name,
    body: service.detail,
    chips: service.points.slice(0, 3),
  }));

  return (
    <section aria-labelledby="services-title" className="section-ink">
      <Container className="grid gap-12 py-20 sm:py-28 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <div data-reveal>
            <Eyebrow index="02">What we do</Eyebrow>
            <h2 id="services-title" className="h-section mt-5">
              <Lines first="Every piece." second="One partner." />
            </h2>
          </div>
          <p className="lede mt-6" data-reveal>
            From the first sketch to the servers it runs on. Design, code, hosting, ads and the care afterwards — from one studio in Grays, and one person
            who has built and hosted everything on this page.
          </p>
          <div className="mt-8" data-reveal>
            <Btn href={contactHref} tone="white-solid" size="lg">
              Tell us what you need
            </Btn>
          </div>
          <p className="eyebrow mt-8 text-[#8e98a8]" data-reveal>
            Designed &amp; built in-house
          </p>
        </div>
        <div className="lg:col-span-7" data-reveal>
          <Accordion items={items} />
        </div>
      </Container>
    </section>
  );
}
