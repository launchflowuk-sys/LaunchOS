import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { marketingLinks } from "@/lib/marketing/links";
import { findWork, STATUS_LABEL, workItems } from "@/lib/marketing/portfolio";
import { CtaBlock } from "../../_components/cta-block";
import { PoweredByBadge } from "../../_components/powered-by";
import { Arrow, Btn, Container, Eyebrow, Lines, Pill } from "../../_components/primitives";
import { Shot } from "../../_components/shot";

/**
 * There is no `generateStaticParams`. The slugs live in the database now, and
 * the route was never prerenderable anyway: the layout reads `headers()` to
 * decide whether links carry the `/site` prefix, which opts the whole tree
 * into dynamic rendering. The five-minute portfolio cache is what keeps it
 * cheap, and a slug that is not a published story is `notFound()` below.
 */
export async function generateMetadata({ params }: PageProps<"/site/work/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const item = await findWork(slug);
  if (!item) return { title: "Not found" };
  return {
    title: item.name,
    description: item.summary,
    alternates: { canonical: `/work/${item.slug}` },
    openGraph: {
      title: `${item.name} — LaunchFlow`,
      description: item.summary,
      url: `/work/${item.slug}`,
      ...(item.screenshots.desktop ? { images: [{ url: item.screenshots.desktop, width: 1440, height: 900, alt: `${item.name} website` }] } : {}),
    },
  };
}

const SECTIONS = [
  ["client", "The client"],
  ["problem", "The problem"],
  ["built", "What we built"],
  ["results", "Results"],
] as const;

/** The brief: the big screenshot first, then the four questions, the facts beside them, and the next project. */
export default async function WorkDetailPage({ params }: PageProps<"/site/work/[slug]">) {
  const { slug } = await params;
  const [{ href }, work] = await Promise.all([marketingLinks(), workItems()]);
  const item = work.find((entry) => entry.slug === slug);
  if (!item) notFound();

  const index = work.findIndex((entry) => entry.slug === item.slug);
  const previous = work[(index - 1 + work.length) % work.length]!;
  const next = work[(index + 1) % work.length]!;
  const host = item.url ? new URL(item.url).host.replace(/^www\./, "") : null;

  return (
    <>
      <Container className="pt-10 sm:pt-14">
        <Link href={href("/work")} className="tlink tlink-quiet text-sm">
          <ArrowLeft aria-hidden className="size-4" strokeWidth={2} />
          All work
        </Link>
        <div className="mt-8 grid gap-8 lg:grid-cols-12 lg:items-end">
          <div className="lg:col-span-8">
            <Eyebrow index={String(index + 1).padStart(2, "0")}>
              {item.sector} · {item.year}
            </Eyebrow>
            <h1 className="h-page mt-5">{item.name}</h1>
            <p className="lede mt-5 text-lg">{item.summary}</p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Pill tone={item.status === "live" ? "live" : "default"}>{STATUS_LABEL[item.status]}</Pill>
              {item.charity ? <Pill tone="tint">Built free, as charity</Pill> : null}
              {item.poweredBy ? <PoweredByBadge platform={item.poweredBy} linked /> : null}
            </div>
          </div>
          {item.url && host ? (
            <div className="lg:col-span-4 lg:justify-self-end">
              <Btn href={item.url} external tone="white">
                Visit {host}
              </Btn>
            </div>
          ) : null}
        </div>
      </Container>

      <Container className="mt-10 sm:mt-14">
        <Shot src={item.screenshots.desktop} alt={`${item.name} on a desktop`} name={item.name} priority inner sizes="(min-width: 1280px) 1216px, 100vw" />
      </Container>

      <Container className="py-14 sm:py-20">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
          <article className="space-y-12 lg:col-span-7">
            {SECTIONS.map(([key, title]) => (
              <section key={key} data-reveal>
                <h2 className="h-sub">{title}</h2>
                <p className="body mt-4 text-[1.0625rem] leading-relaxed">{item.brief[key]}</p>
              </section>
            ))}
          </article>

          <aside className="lg:col-span-5" data-reveal>
            <div className="card p-6 sm:p-8 lg:sticky lg:top-24">
              <dl className="space-y-5 text-[0.9375rem]">
                <Fact label="Client">{item.client}</Fact>
                <Fact label="Sector">{item.sector}</Fact>
                <Fact label="Year">
                  <span className="tabular">{item.year}</span>
                </Fact>
                <Fact label="Status">{STATUS_LABEL[item.status]}</Fact>
                {item.poweredBy ? (
                  <Fact label="Platform">
                    <a href={item.poweredBy.url} rel="noopener" className="link-blue">
                      {item.poweredBy.name}
                    </a>
                    <span className="quiet"> — our own</span>
                  </Fact>
                ) : null}
                <div>
                  <dt className="eyebrow">Stack</dt>
                  <dd className="mt-3 flex flex-wrap gap-2">
                    {item.stack.map((tech) => (
                      <span key={tech} className="chip">
                        {tech}
                      </span>
                    ))}
                  </dd>
                </div>
                {item.url && host ? (
                  <Fact label="Live site">
                    <a href={item.url} rel="noopener" className="link-blue">
                      {host}
                    </a>
                  </Fact>
                ) : null}
              </dl>
              {item.screenshots.mobile ? (
                <div className="mt-8 border-t border-[var(--line)] pt-8">
                  <p className="eyebrow">On a phone</p>
                  <div className="mt-4">
                    <Shot src={item.screenshots.mobile} alt={`${item.name} on a phone`} name={item.name} kind="mobile" sizes="16rem" />
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        </div>

        <nav aria-label="More work" className="mt-16 grid gap-4 border-t border-[var(--line)] pt-8 sm:grid-cols-2">
          <Link href={href(`/work/${previous.slug}`)} className="card card-hover group p-6">
            <p className="tlink tlink-quiet text-sm">
              <ArrowLeft aria-hidden className="size-4" strokeWidth={2} />
              Previous
            </p>
            <p className="h-card mt-2 transition-colors group-hover:text-[var(--blue)]">{previous.name}</p>
          </Link>
          <Link href={href(`/work/${next.slug}`)} className="card card-hover group p-6 text-right">
            <p className="tlink tlink-quiet justify-end text-sm">
              Next
              <Arrow kind="right" />
            </p>
            <p className="h-card mt-2 transition-colors group-hover:text-[var(--blue)]">{next.name}</p>
          </Link>
        </nav>
      </Container>

      <CtaBlock
        title={<Lines first="Need something" second="like this?" />}
        body="Tell us about your business and we will tell you what we would build, and what it would cost."
        primary={{ label: "Tell us about your project", href: href("/contact") }}
      />
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1.5 font-medium">{children}</dd>
    </div>
  );
}
