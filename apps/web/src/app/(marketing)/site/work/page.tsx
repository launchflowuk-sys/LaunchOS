import type { Metadata } from "next";
import { marketingLinks } from "@/lib/marketing/links";
import { workItems } from "@/lib/marketing/portfolio";
import { CtaBlock } from "../_components/cta-block";
import { Container, Lines, SectionHead } from "../_components/primitives";
import { WorkCard } from "../_components/work-card";

export const metadata: Metadata = {
  title: "Work",
  description: "Websites, booking systems, dispatch platforms and apps we have built for taxi firms, salons, tutors, takeaways and trades in Essex.",
  alternates: { canonical: "/work" },
  openGraph: { title: "Work — LaunchFlow", description: "Real businesses, real systems, screenshots from the live sites.", url: "/work" },
};

export default async function WorkPage() {
  const [{ href }, work] = await Promise.all([marketingLinks(), workItems()]);

  return (
    <>
      <Container className="pt-14 sm:pt-20">
        <SectionHead
          level={1}
          index="01"
          eyebrow="Selected work"
          title={<Lines first="Work that earns" second="its keep." />}
          aside="Every project here is a real business we built for, with a brief you can read: who they are, what was wrong, what we built and what happened. Screenshots are taken from the live sites."
        />
      </Container>
      <Container className="py-16 sm:py-20">
        <div className="grid gap-x-8 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
          {work.map((item, index) => (
            <WorkCard key={item.slug} item={item} href={href(`/work/${item.slug}`)} priority={index < 2} />
          ))}
        </div>
      </Container>
      <CtaBlock
        title={<Lines first="Yours could" second="be next." />}
        body="Tell us the problem. We will tell you the smallest thing that fixes it and what it costs."
        primary={{ label: "Tell us about your project", href: href("/contact") }}
      />
    </>
  );
}
