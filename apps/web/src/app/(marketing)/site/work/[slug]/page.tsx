import type { Metadata } from "next";
import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { marketingLinks } from "@/lib/marketing/links";
import { findWork, STATUS_LABEL, WORK, WORK_SLUGS } from "@/lib/marketing/work";
import { Container, CtaBand, LinkButton, Tag } from "../../_components/primitives";
import { Shot } from "../../_components/shot";

export function generateStaticParams(): { slug: string }[] {
  return WORK_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps<"/site/work/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const item = findWork(slug);
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

export default async function WorkDetailPage({ params }: PageProps<"/site/work/[slug]">) {
  const { slug } = await params;
  const item = findWork(slug);
  if (!item) notFound();
  const { href } = await marketingLinks();

  const index = WORK.findIndex((entry) => entry.slug === item.slug);
  const previous = WORK[(index - 1 + WORK.length) % WORK.length]!;
  const next = WORK[(index + 1) % WORK.length]!;
  const host = item.url ? new URL(item.url).host.replace(/^www\./, "") : null;

  return (
    <>
      <Container className="pt-10 sm:pt-14">
        <Link href={href("/work")} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft aria-hidden className="size-4" />
          All work
        </Link>
        <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <Tag>{item.sector}</Tag>
              <Tag>{STATUS_LABEL[item.status]}</Tag>
              {item.charity ? <Tag className="border-success-border bg-success-bg text-success-fg">Built free, as charity</Tag> : null}
            </div>
            <h1 className="display mt-4 text-4xl sm:text-5xl">{item.name}</h1>
            <p className="lede mt-4 text-lg text-muted-foreground sm:text-xl">{item.summary}</p>
          </div>
          {item.url && host ? (
            <div className="shrink-0">
              <LinkButton href={item.url} external variant="secondary">
                Visit {host}
                <ExternalLink aria-hidden />
              </LinkButton>
            </div>
          ) : null}
        </div>
      </Container>

      <Container className="mt-10 sm:mt-14">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
          <Shot src={item.screenshots.desktop} alt={`${item.name} on a desktop`} name={item.name} priority sizes="(min-width: 1024px) 70vw, 100vw" />
          <div className="hidden lg:block">
            <Shot src={item.screenshots.mobile} alt={`${item.name} on a phone`} name={item.name} kind="mobile" sizes="16rem" />
          </div>
        </div>
      </Container>

      <Container className="py-12 sm:py-16">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:gap-16">
          <article className="space-y-10">
            {SECTIONS.map(([key, title]) => (
              <section key={key}>
                <h2 className="text-xl font-semibold sm:text-2xl">{title}</h2>
                <p className="mt-3 text-base leading-relaxed sm:text-lg">{item.brief[key]}</p>
              </section>
            ))}
          </article>

          <aside className="rounded-2xl border bg-background p-6 lg:sticky lg:top-24">
            <dl className="space-y-5 text-sm">
              <div>
                <dt className="label-caps text-muted-foreground">Client</dt>
                <dd className="mt-1 font-medium">{item.client}</dd>
              </div>
              <div>
                <dt className="label-caps text-muted-foreground">Sector</dt>
                <dd className="mt-1 font-medium">{item.sector}</dd>
              </div>
              <div>
                <dt className="label-caps text-muted-foreground">Year</dt>
                <dd className="mt-1 font-medium tabular-nums">{item.year}</dd>
              </div>
              <div>
                <dt className="label-caps text-muted-foreground">Status</dt>
                <dd className="mt-1 font-medium">{STATUS_LABEL[item.status]}</dd>
              </div>
              <div>
                <dt className="label-caps text-muted-foreground">Stack</dt>
                <dd className="mt-2 flex flex-wrap gap-1.5">
                  {item.stack.map((tech) => (
                    <Tag key={tech} className="bg-card">
                      {tech}
                    </Tag>
                  ))}
                </dd>
              </div>
              {item.url && host ? (
                <div>
                  <dt className="label-caps text-muted-foreground">Live site</dt>
                  <dd className="mt-1">
                    <a href={item.url} rel="noopener" className="font-medium text-primary hover:underline">
                      {host}
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
          </aside>
        </div>

        {item.screenshots.mobile ? (
          <div className="mt-12 lg:hidden">
            <h2 className="text-xl font-semibold">On a phone</h2>
            <div className="mt-4">
              <Shot src={item.screenshots.mobile} alt={`${item.name} on a phone`} name={item.name} kind="mobile" sizes="16rem" />
            </div>
          </div>
        ) : null}

        <nav aria-label="More work" className="mt-14 grid gap-4 border-t pt-8 sm:grid-cols-2">
          <Link href={href(`/work/${previous.slug}`)} className="group rounded-xl border bg-card p-5 hover:border-primary/60">
            <p className="flex items-center gap-1.5 text-meta font-medium text-muted-foreground">
              <ArrowLeft aria-hidden className="size-3.5" />
              Previous
            </p>
            <p className="mt-1 font-semibold group-hover:underline">{previous.name}</p>
          </Link>
          <Link href={href(`/work/${next.slug}`)} className="group rounded-xl border bg-card p-5 text-right hover:border-primary/60">
            <p className="flex items-center justify-end gap-1.5 text-meta font-medium text-muted-foreground">
              Next
              <ArrowRight aria-hidden className="size-3.5" />
            </p>
            <p className="mt-1 font-semibold group-hover:underline">{next.name}</p>
          </Link>
        </nav>
      </Container>

      <CtaBand
        title="Need something like this?"
        lede="Tell us about your business and we will tell you what we would build, and what it would cost."
        primary={{ label: "Talk to us", href: href("/contact") }}
        secondary={{ label: "All work", href: href("/work") }}
      />
    </>
  );
}
