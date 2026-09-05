import {
  latestSubscriptionChange,
  SUBSCRIPTION_CHANGE_KINDS,
  SUBSCRIPTION_CHANGE_LABEL,
  SubscriptionChangePayload,
  ukLongDate,
} from "@launchos/core";
import { schema } from "@launchos/db";
import type { PackageIncludes } from "@launchos/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Package } from "lucide-react";
import Link from "next/link";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PortalForm } from "@/components/portal/portal-form";
import { PortalSelect } from "@/components/portal/portal-select";
import { Section } from "@/components/section";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { requestPlanChange } from "./actions";

export const dynamic = "force-dynamic";

/** Portal words for the five subscription states. */
const PLAN_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  active: { label: "Active", tone: "success" },
  trialing: { label: "Trial", tone: "info" },
  past_due: { label: "Payment overdue", tone: "danger" },
  paused: { label: "Paused", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

function PlanStatusBadge({ value }: { value: string }) {
  const presentation = PLAN_STATUS[value];
  if (!presentation) return <StatusBadge value={value} />;
  return <StatusBadge value={value} label={presentation.label} tone={presentation.tone} />;
}

/** "4 social posts a month", "1 blog post a month". */
function perMonth(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural} a month`;
}

/** What the package includes, in the client's words. Quantities of zero are left out. */
function humaniseIncludes(includes: PackageIncludes): string[] {
  const lines: string[] = [];
  if (includes.website) lines.push("Website hosting and care");
  if (includes.seo) lines.push("Search engine optimisation");
  if (includes.ads) lines.push("Ad management");
  if (includes.socialPostsPerMonth > 0) lines.push(perMonth(includes.socialPostsPerMonth, "social post", "social posts"));
  if (includes.blogPostsPerMonth > 0) lines.push(perMonth(includes.blogPostsPerMonth, "blog post", "blog posts"));
  if (includes.gbpUpdatesPerMonth > 0) {
    lines.push(perMonth(includes.gbpUpdatesPerMonth, "Google Business Profile update", "Google Business Profile updates"));
  }
  return lines;
}

export default async function PortalPlanPage() {
  const session = await requireClient();
  const db = getDb();

  // The newest subscription, whatever its state: a client whose plan was
  // cancelled last week should see "Cancelled" and the date it ends, not an
  // empty page that says nothing was ever set up.
  const [subscription] = await db
    .select()
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.organisationId, session.organisationId),
        eq(schema.subscriptions.clientId, session.clientId),
        isNull(schema.subscriptions.deletedAt),
      ),
    )
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1);

  const [pkg] = subscription?.packageId
    ? await db
        .select()
        .from(schema.packages)
        .where(and(eq(schema.packages.id, subscription.packageId), eq(schema.packages.organisationId, session.organisationId)))
    : [];

  const latest = await latestSubscriptionChange(db, session.organisationId, session.clientId);
  const latestPayload = latest ? SubscriptionChangePayload.safeParse(latest.payload) : undefined;
  const latestKind = latestPayload?.success ? latestPayload.data.kind : undefined;
  const pending = latest?.status === "pending" ? latest : undefined;
  const decided = latest && latest.status !== "pending" ? latest : undefined;

  return (
    <>
      <PageHeader
        title="Plan"
        description="Your LaunchFlow package, what it includes, and how to change it."
        category="money"
      />

      {!subscription ? (
        <EmptyState
          icon={Package}
          title="No plan set up yet"
          action={
            <Button asChild variant="secondary">
              <Link href="/portal/support">Go to Support</Link>
            </Button>
          }
        >
          Nothing is set up on your account yet. If you were expecting a package here, raise a support request and we
          will sort it out.
        </EmptyState>
      ) : (
        <>
          <Section title="Your package">
            <div className="rounded-xl border bg-card p-5">
              <KeyValue
                columns={2}
                items={[
                  {
                    label: "Package",
                    value: (
                      <span className="inline-flex flex-wrap items-center gap-2 text-base font-semibold">
                        {pkg?.name ?? "Monthly retainer"}
                        <PlanStatusBadge value={subscription.status} />
                      </span>
                    ),
                  },
                  {
                    label: "Monthly price",
                    value: (
                      <span className="text-base font-semibold tabular-nums">
                        {formatPence(subscription.amountPence, subscription.currency)}
                      </span>
                    ),
                    hint: "Billed monthly, VAT shown on each invoice.",
                  },
                  {
                    label: subscription.status === "cancelled" ? "Ends on" : "Next renewal",
                    value: ukLongDate(subscription.currentPeriodEnd),
                  },
                  {
                    label: "What is included",
                    value:
                      pkg && humaniseIncludes(pkg.includes).length > 0 ? (
                        <ul className="list-disc space-y-1 pl-5">
                          {humaniseIncludes(pkg.includes).map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      ) : (
                        "Ask us for the details of your package."
                      ),
                  },
                ]}
              />
            </div>
          </Section>

          <Section
            title="Need to change something?"
            description="Tell us what you would like to do. Nothing changes until LaunchFlow has confirmed it with you."
          >
            <div className="max-w-2xl rounded-xl border bg-card p-5 sm:p-6">
              {decided && latestKind ? (
                <InlineAlert
                  tone={decided.status === "approved" ? "success" : "info"}
                  title={`Your request was ${decided.status === "approved" ? "approved" : "declined"}`}
                  className="mb-5"
                >
                  <p>
                    {SUBSCRIPTION_CHANGE_LABEL[latestKind]} — decided {formatDate(decided.decidedAt)}.
                    {decided.decisionNote ? ` LaunchFlow said: ${decided.decisionNote}` : ""}
                  </p>
                </InlineAlert>
              ) : null}

              {pending ? (
                <div data-testid="plan-change-pending">
                  <InlineAlert tone="info" title="Request sent — LaunchFlow will confirm">
                    <p>We have your request and will be in touch. Nothing changes until we have confirmed it with you.</p>
                  </InlineAlert>
                  <KeyValue
                    className="mt-5"
                    columns={2}
                    items={[
                      { label: "Request", value: latestKind ? SUBSCRIPTION_CHANGE_LABEL[latestKind] : "Plan change" },
                      { label: "Sent", value: formatDate(pending.createdAt) },
                    ]}
                  />
                  <div className="mt-5">
                    <Button type="button" size="lg" disabled className="w-full sm:w-auto">
                      Request sent
                    </Button>
                  </div>
                </div>
              ) : subscription.status === "cancelled" ? (
                <InlineAlert tone="info">
                  Your plan has been cancelled. If you would like to start again, raise a support request and we will
                  set it up.
                </InlineAlert>
              ) : (
                <PortalForm action={requestPlanChange} submitLabel="Send request" ariaLabel="Request a plan change">
                  <div className="space-y-5">
                    <div className="space-y-1.5">
                      <Label htmlFor="plan-change-kind">What would you like to do?</Label>
                      <PortalSelect id="plan-change-kind" name="kind" defaultValue="other">
                        {SUBSCRIPTION_CHANGE_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {SUBSCRIPTION_CHANGE_LABEL[kind]}
                          </option>
                        ))}
                      </PortalSelect>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="plan-change-message">Tell us more</Label>
                      <Textarea
                        id="plan-change-message"
                        name="message"
                        required
                        rows={5}
                        maxLength={4000}
                        className="min-h-32 bg-card"
                      />
                      <p className="text-meta text-muted-foreground">
                        A line or two on why, and when you would like it to happen.
                      </p>
                    </div>
                  </div>
                </PortalForm>
              )}
            </div>
          </Section>
        </>
      )}
    </>
  );
}
