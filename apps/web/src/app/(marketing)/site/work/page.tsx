import type { Metadata } from "next";
import { marketingLinks } from "@/lib/marketing/links";
import { WORK } from "@/lib/marketing/work";
import { Container, CtaBand, PageIntro } from "../_components/primitives";
import { WorkCard } from "../_components/work-card";

export const metadata: Metadata = {
  title: "Work",
  description: "Websites, booking systems, dispatch platforms and apps we have built for taxi firms, salons, tutors, takeaways and trades in Essex.",
  alternates: { canonical: "/work" },
  openGraph: { title: "Work — LaunchFlow", description: "Real businesses, real systems, screenshots from the live sites.", url: "/work" },
};

export default async function WorkPage() {
  const { href } = await marketingLinks();

  return (
    <>
      <PageIntro
        title="Work"
        lede="Every project here is a real business we built for, with a brief you can read: who they are, what was wrong, what we built and what happened. Screenshots are taken from the live sites."
      />
      <Container className="pb-16 sm:pb-20">
        <div className="grid gap-x-8 gap-y-12 md:grid-cols-2 lg:grid-cols-3">
          {WORK.map((item, index) => (
            <WorkCard key={item.slug} item={item} href={href(`/work/${item.slug}`)} priority={index < 2} />
          ))}
        </div>
      </Container>
      <CtaBand
        title="Yours could be next."
        lede="Tell us the problem. We will tell you the smallest thing that fixes it and what it costs."
        primary={{ label: "Talk to us", href: href("/contact") }}
        secondary={{ label: "Our products", href: href("/products") }}
      />
    </>
  );
}
