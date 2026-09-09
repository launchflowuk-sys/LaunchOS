import { listClients, listSupplierCosts, upcomingCosts } from "@launchos/core";
import { CalendarClock, TriangleAlert, Wallet } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";
import { assignCostAction, syncCostsAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Costs" };

/**
 * What LaunchFlow pays, and who it is paid for.
 *
 * The revenue side of every client has always been visible and the cost side
 * never was, so "this client brings in £950" was as far as anybody could get.
 * The obstacle is that a supplier names a subscription after the product —
 * `.LIVE Domain`, `Starter Business Email` — and never after the client, so
 * nothing here can be matched automatically with any confidence. The sync
 * guesses only where exactly one domain could be meant, marks it as a guess,
 * and this screen is where a person turns guesses into answers.
 */

/** Minor units in the supplier's own currency — never converted, see the schema. */
function supplierMoney(minor: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  return `${symbol}${(minor / 100).toFixed(2)}${symbol ? "" : ` ${currency}`}`;
}

function totalsByCurrency(rows: readonly { renewalPrice: number; currencyCode: string }[]): string {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currencyCode, (totals.get(row.currencyCode) ?? 0) + row.renewalPrice);
  if (totals.size === 0) return supplierMoney(0, "USD");
  return [...totals.entries()].map(([currency, total]) => supplierMoney(total, currency)).join(" · ");
}

const MATCH_LABEL = {
  unassigned: "Not assigned",
  suggested: "Guessed",
  confirmed: "Confirmed",
} as const;

export default async function CostsPage() {
  const session = await requireAdmin();
  const db = getDb();

  const [costs, upcoming, clients] = await Promise.all([
    listSupplierCosts(db, session.organisationId),
    upcomingCosts(db, session.organisationId),
    listClients(db, session.organisationId, {}),
  ]);

  const trials = costs.filter((row) => row.status === "in_trial" && row.autoRenewed);
  const unattributed = costs.filter((row) => row.match !== "confirmed");

  return (
    <>
      <PageHeader
        title="Costs"
        description="What we pay suppliers, and which client each one is for."
        category="money"
        actions={
          <ActionForm action={syncCostsAction} success="Synced from the supplier" ariaLabel="Sync costs">
            <Button type="submit" variant="secondary">Sync now</Button>
          </ActionForm>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Per renewal"
          value={totalsByCurrency(costs.filter((row) => row.status !== "cancelled"))}
          hint={`${costs.length} subscription${costs.length === 1 ? "" : "s"}`}
          category="money"
          icon={Wallet}
        />
        <StatCard
          label="Due in 45 days"
          value={totalsByCurrency(upcoming)}
          hint={upcoming.length === 0 ? "Nothing due" : `${upcoming.length} coming up`}
          category="money"
          icon={CalendarClock}
        />
        <StatCard
          label="Trials that will charge"
          value={trials.length}
          hint={trials.length === 0 ? "None on trial" : totalsByCurrency(trials)}
          category={trials.length > 0 ? "support" : "money"}
          icon={TriangleAlert}
        />
      </div>

      {/* A trial set to auto-renew is a charge nobody planned for, and it is
          the one thing on this screen with a deadline. */}
      {trials.length > 0 ? (
        <Section
          title="Trials that will start charging"
          description="These renew automatically. Cancel them at the supplier or they become a bill."
          className="mt-8"
        >
          <div className="rounded-[20px] border border-warning-border bg-warning-bg p-5">
            <ul className="min-w-0 divide-y divide-warning-fg/15">
              {trials.map((row) => (
                <li key={row.id} className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                  <span className="min-w-0 flex-1 font-medium text-warning-fg">{row.name}</span>
                  <span className="tabular-nums text-warning-fg">
                    {supplierMoney(row.renewalPrice, row.currencyCode)}
                  </span>
                  <span className="text-meta whitespace-nowrap text-warning-fg/80">
                    {row.nextBillingAt ? `from ${formatDate(row.nextBillingAt)}` : "no date"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}

      <Section
        title="Every subscription"
        description="Assign each one to the client it is for. A confirmed answer is never overwritten by a sync."
        className="mt-8"
      >
        {costs.length === 0 ? (
          <EmptyState icon={Wallet}>
            Nothing synced yet. Press Sync now, or wait for the nightly job — it needs HOSTINGER_API_TOKEN.
          </EmptyState>
        ) : (
          <div className="divide-y rounded-[20px] border bg-card px-4">
            {costs.map((row) => (
              <div key={row.id} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 py-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{row.name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
                    <span className="tabular-nums">{supplierMoney(row.renewalPrice, row.currencyCode)} per renewal</span>
                    <span aria-hidden>·</span>
                    <span>{row.nextBillingAt ? formatDate(row.nextBillingAt) : "no renewal date"}</span>
                    <span aria-hidden>·</span>
                    <span
                      className={cn(
                        "font-semibold",
                        row.match === "confirmed" && "text-success-fg",
                        row.match === "suggested" && "text-warning-fg",
                      )}
                    >
                      {MATCH_LABEL[row.match]}
                    </span>
                    {row.status !== "active" ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>{row.status.replaceAll("_", " ")}</span>
                      </>
                    ) : null}
                  </p>
                </div>

                <ActionForm
                  action={assignCostAction}
                  success={`Saved ${row.name}`}
                  ariaLabel={`Assign ${row.name}`}
                  className="flex shrink-0 items-center gap-2"
                >
                  <input type="hidden" name="costId" value={row.id} />
                  <NativeSelect name="clientId" defaultValue={row.clientId ?? ""} className="min-w-52">
                    <option value="">Not assigned</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>{client.name}</option>
                    ))}
                  </NativeSelect>
                  <Button type="submit" variant="secondary" size="sm">Save</Button>
                </ActionForm>
              </div>
            ))}
          </div>
        )}

        {unattributed.length > 0 ? (
          <p className="mt-3 text-meta text-muted-foreground">
            {unattributed.length} of {costs.length} are still a guess or unassigned, so their cost is not counted
            against any client&rsquo;s margin yet.
          </p>
        ) : null}
      </Section>
    </>
  );
}
