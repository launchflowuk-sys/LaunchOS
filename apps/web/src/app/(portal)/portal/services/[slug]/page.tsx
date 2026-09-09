import { getOffering, listPortalCatalogue, priceOf, type Offering } from "@launchos/core";
import { ArrowLeft, Check, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { startPurchaseAction } from "../actions";

export const dynamic = "force-dynamic";

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
 * One service, and the button that buys it.
 *
 * The only genuinely opinionated thing on this page is the warning. A client
 * already paying a monthly retainer who buys another gets a *second* monthly
 * charge, not an upgrade — that is how the flow is meant to work, but it is
 * not what somebody clicking "Add" is usually picturing. So the page says the
 * number out loud and offers the plan-change route beside it. Both ways stay
 * open; nobody is refunded for guessing wrong.
 */
export default async function ServiceDetailPage({ params, searchParams }: PageProps<"/portal/services/[slug]">) {
  const session = await requireClient();
  const { slug } = await params;
  const query = await searchParams;
  const db = getDb();

  const offering = await getOffering(db, session.organisationId, slug);
  if (!offering) notFound();

  const { liveRetainers } = await listPortalCatalogue(db, session.organisationId, session.clientId);
  const current = liveRetainers[0];
  const wouldStack = offering.kind === "retainer" && liveRetainers.length > 0;
  const includes = includeLines(offering);
  const total = priceOf(offering);

  return (
    <>
      <Link
        href="/portal/services"
        className="mb-5 inline-flex items-center gap-1.5 text-row font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden strokeWidth={2} className="size-4" />
        All services
      </Link>

      <div className="mb-6">
        <h1 className="text-title font-bold tracking-[-0.01em]">{offering.name}</h1>
        {offering.description ? (
          <p className="mt-2 text-base text-muted-foreground">{offering.description}</p>
        ) : null}
      </div>

      {query.cancelled ? (
        <div className="mb-6 rounded-[20px] border bg-muted/50 p-5">
          <p className="font-semibold">No payment was taken.</p>
          <p className="mt-1 text-row text-muted-foreground">
            You came back before finishing. Nothing has changed on your account.
          </p>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {includes.length > 0 ? (
            <section className="rounded-[20px] border bg-card p-5">
              <h2 className="font-semibold">What you get</h2>
              <ul className="mt-3 space-y-2">
                {includes.map((line) => (
                  <li key={line} className="flex items-start gap-2.5 text-row">
                    <Check aria-hidden strokeWidth={2.2} className="mt-0.5 size-4 shrink-0 text-success-fg" />
                    <span className="min-w-0">{line}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {wouldStack ? (
            <section className="rounded-[20px] border border-warning-border bg-warning-bg p-5">
              <p className="flex items-center gap-2 font-semibold text-warning-fg">
                <TriangleAlert aria-hidden strokeWidth={2} className="size-4 shrink-0" />
                This adds a second monthly charge
              </p>
              <p className="mt-2 text-row text-warning-fg/90">
                You are already on{" "}
                <strong>{current?.name ?? "a monthly plan"}</strong>
                {current && current.amountPence > 0
                  ? ` at ${formatMoney(current.amountPence, offering.currency)} a month`
                  : ""}
                . Adding this one does not replace it — you would be paying for both. If you meant to change
                plan instead, ask us and we will move you across with nothing charged twice.
              </p>
              <Button asChild variant="secondary" size="sm" className="mt-4">
                <Link href="/portal/plan">Change my plan instead</Link>
              </Button>
            </section>
          ) : null}
        </div>

        <aside className="min-w-0">
          <div className="rounded-[20px] border bg-card p-5">
            <p className="label-caps text-muted-foreground">
              {offering.kind === "retainer" ? "Monthly" : "One-off"}
            </p>
            <p className="mt-1 text-figure font-bold tracking-[-0.01em]">
              {formatMoney(offering.kind === "retainer" ? offering.monthlyPricePence : total, offering.currency)}
              {offering.kind === "retainer" ? (
                <span className="text-base font-medium text-muted-foreground"> a month</span>
              ) : null}
            </p>

            {offering.kind === "retainer" && offering.setupPricePence > 0 ? (
              <p className="mt-1 text-row text-muted-foreground">
                Plus {formatMoney(offering.setupPricePence, offering.currency)} to set up, on the first invoice.
              </p>
            ) : null}

            {offering.trialDays > 0 ? (
              <p className="mt-3 rounded-[14px] bg-success-bg px-3 py-2 text-row font-medium text-success-fg">
                {offering.trialDays} days free. We take your card now and charge nothing until the trial ends.
              </p>
            ) : null}

            <ActionForm action={startPurchaseAction} className="mt-5" ariaLabel={`Buy ${offering.name}`}>
              <input type="hidden" name="slug" value={offering.slug} />
              <Button type="submit" size="lg" className="w-full">
                {offering.trialDays > 0 ? "Start free trial" : "Add to my account"}
              </Button>
            </ActionForm>

            <p className="mt-3 text-meta text-muted-foreground">
              You will be taken to our payment provider. We start work as soon as it goes through.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
