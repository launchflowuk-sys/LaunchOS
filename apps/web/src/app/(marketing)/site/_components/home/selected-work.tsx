import { featuredWork } from "@/lib/marketing/portfolio";
import { Container, Lines, SectionHead } from "../primitives";
import { WorkCard } from "../work-card";

/**
 * 01 / SELECTED WORK — every featured project, published rows only.
 *
 * Not sliced here. `featuredWork()` already caps the list, and slicing twice
 * meant marking a sixth project featured put it fifth in a list of three —
 * the flag was set, the admin screen said featured, and the home page never
 * showed it. Which projects appear is a decision for the Case studies screen,
 * not for this component.
 */
export async function SelectedWork({ href }: { href: (path: string) => string }) {
  const items = await featuredWork();
  return (
    <section aria-labelledby="work-title" className="py-20 sm:py-28">
      <Container>
        <SectionHead
          id="work-title"
          index="01"
          eyebrow="Selected work"
          title={<Lines first="Good things," second="built for real people." />}
          aside="Every project here is a real business — a taxi firm, a groomer, a salon — with a brief you can read and a live site you can visit."
          link={{ label: "See all projects", href: href("/work") }}
        />
        <div className="mt-14 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <WorkCard key={item.slug} item={item} href={href(`/work/${item.slug}`)} />
          ))}
        </div>
      </Container>
    </section>
  );
}
