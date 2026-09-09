import { listPortalCatalogue, type Offering } from "@launchos/core";
import { ArrowRight, Check, MessageCircleQuestion, Sparkles } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = { title: "Add a service" };

const KIND_LABEL: Record<Offering["kind"], string> = {
  retainer: "Monthly",
  one_off: "One-off",
  addon: "Add-on",
};

/** "£450 a month", "£1,200 once" — the whole price in one phrase, no small print. */
function priceLine(offering: Offering): string {
  if (offering.kind === "retainer") {
    const monthly = `${formatMoney(offering.monthlyPricePence, offering.currency)} a month`;
    return offering.setupPricePence > 0
      ? `${monthly}, plus ${formatMoney(offering.setupPricePence, offering.currency)} to set up`
      : monthly;
  }
  const once = offering.setupPricePence || offering.monthlyPricePence;
  return `${formatMoney(once, offering.currency)} once`;
}

/** What the package includes, in the client's words. Zero quantities are left out. */
function includeLines(offering: Offering): string[] {
  const it = offering.includes;
  const lines: string[] = [];
  if (it.website) lines.push("Website looked after");
  if (it.seo) lines.push("SEO");
  if (it.ads) lines.push("Ads managed");
  if (it.socialPostsPerMonth > 0) lines.push(`${it.socialPostsPerMonth} social posts a month`);
  if (it.blogPostsPerMonth > 0) lines.push(`${it.blogPostsPerMonth} blog posts a month`);
  if (it.gbpUpdatesPerMonth > 0) lines.push(`${it.gbpUpdatesPerMonth} Google Business updates a month`);
  return lines;
}

/**
 * What a client can add to their account without asking us first.
 *
 * Only packages somebody has deliberately opened to self-serve appear here,
 * and only those with a Stripe price behind them — so this screen is empty
 * until the catalogue is set up, which is the right way round. The tile at the
 * end is the way out for everything we do not sell off the shelf.
 */
export default async function PortalServicesPage({ searchParams }: PageProps<"/portal/services">) {
  const session = await requireClient();
  const params = await searchParams;
  const { offerings, liveRetainers } = await listPortalCatalogue(
    getDb(),
    session.organisationId,
    session.clientId,
  );

  return (
    <>
      <div className="mb-6">
        <p className="label-caps text-primary">Your LaunchFlow workspace</p>
        <h1 className="mt-1 text-title font-bold tracking-[-0.01em]">Add a service</h1>
        <p className="mt-1.5 text-base text-muted-foreground">
          Anything here you can start today. Everything else, just ask.
        </p>
      </div>

      {params.enquired ? (
        <div className="mb-6 rounded-[20px] border border-success-border bg-success-bg p-5">
          <p className="font-semibold text-success-fg">Thanks — we have got that.</p>
          <p className="mt-1 text-row text-success-fg/90">
            We will come back to you with a price and a plan. Nothing is charged until you agree to it.
          </p>
        </div>
      ) : null}

      {offerings.length === 0 ? (
        <EmptyState icon={Sparkles}>
          Nothing to add here just yet. Tell us what you are after and we will put something together.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {offerings.map((offering) => {
            const includes = includeLines(offering);
            const alreadyOn = liveRetainers.some((row) => row.packageId === offering.id);
            return (
              <Link
                key={offering.id}
                href={`/portal/services/${offering.slug}`}
                className="group flex min-w-0 flex-col rounded-[20px] border bg-card p-5 transition-colors hover:border-primary"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="label-caps text-muted-foreground">{KIND_LABEL[offering.kind]}</span>
                  {offering.trialDays > 0 ? (
                    <span className="rounded-full bg-success-bg px-2.5 py-1 text-label font-semibold text-success-fg">
                      {offering.trialDays}-day free trial
                    </span>
                  ) : null}
                </div>

                <h2 className="mt-2 text-lg font-semibold tracking-[-0.01em]">{offering.name}</h2>
                <p className="mt-1 text-row font-semibold text-primary">{priceLine(offering)}</p>

                {offering.description ? (
                  <p className="mt-2 line-clamp-2 text-row text-muted-foreground">{offering.description}</p>
                ) : null}

                {includes.length > 0 ? (
                  <ul className="mt-4 space-y-1.5">
                    {includes.slice(0, 4).map((line) => (
                      <li key={line} className="flex items-start gap-2 text-row">
                        <Check aria-hidden strokeWidth={2.2} className="mt-0.5 size-4 shrink-0 text-success-fg" />
                        <span className="min-w-0">{line}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <p
                  className={cn(
                    "mt-5 flex items-center gap-1.5 text-row font-semibold text-primary",
                    "transition-transform group-hover:translate-x-0.5",
                  )}
                >
                  {alreadyOn ? "You are already on this" : "See what is included"}
                  <ArrowRight aria-hidden strokeWidth={2} className="size-4" />
                </p>
              </Link>
            );
          })}
        </div>
      )}

      {/* The way out for everything we do not sell off the shelf — a new
          website being the one people actually ask for. */}
      <Link
        href="/portal/services/enquire"
        className="mt-4 flex min-w-0 items-center gap-4 rounded-[20px] border border-dashed p-5 transition-colors hover:border-primary hover:bg-primary-soft/40"
      >
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-primary-soft text-primary"
        >
          <MessageCircleQuestion strokeWidth={1.75} className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Something else?</span>
          <span className="block text-row text-muted-foreground">
            A new website, or anything not listed. Tell us what you need and we will price it.
          </span>
        </span>
        <ArrowRight aria-hidden strokeWidth={2} className="size-5 shrink-0 text-primary" />
      </Link>
    </>
  );
}
