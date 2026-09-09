import { listClients, listSupplierCosts, upcomingCosts, type CostRow } from "@launchos/core";
import { CalendarClock, CircleHelp, TriangleAlert, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { assignCostAction, syncCostsAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Costs" };

/**
 * What LaunchFlow pays, and who it is paid for.
 *
 * The revenue side of every client has always been visible and the cost side
 * never was, so "this client brings in £950" was as far as anybody could get.
 *
 * The obstacle used to be that a supplier names a subscription after the
 * product — `.LIVE Domain`, `Starter Business Email` — and never after the
 * client, so fifty-three rows arrived that nobody could tell apart. They are
 * resolved now by the moment they were bought (`matchCostToDomain`), so a line
 * says which domain it pays for and inherits that domain's client. What is
 * left on this screen is what genuinely cannot be resolved: products the
 * supplier does not tie to a domain at all.
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

/**
 * What the line is actually for.
 *
 * The supplier's own product name stays as the subtitle rather than being
 * thrown away: it is what appears on their invoice, so it is what somebody
 * checking a charge against the bill will be looking for.
 */
function lineTitle(row: CostRow): string {
  return row.domainName ?? row.name;
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

  const live = costs.filter((row) => row.status !== "cancelled");
  const trials = costs.filter((row) => row.status === "in_trial" && row.autoRenewed);
  const unassigned = costs.filter((row) => row.clientId === null && row.status !== "cancelled");
  const attributed = live.filter((row) => row.clientId !== null);

  // One row per client, so "what does this client cost me" is a glance rather
  // than a scan of fifty-three lines.
  const byClient = new Map<string, { name: string; rows: CostRow[] }>();
  for (const row of attributed) {
    const key = row.clientId!;
    const group = byClient.get(key) ?? { name: row.clientName ?? "Unknown", rows: [] };
    group.rows.push(row);
    byClient.set(key, group);
  }
  const clientGroups = [...byClient.entries()]
    .map(([clientId, group]) => ({ clientId, ...group }))
    .sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));

  const assignCell = (row: CostRow) => (
    <ActionForm
      action={assignCostAction}
      success={`Saved ${lineTitle(row)}`}
      ariaLabel={`Assign ${lineTitle(row)}`}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="costId" value={row.id} />
      <NativeSelect name="clientId" defaultValue={row.clientId ?? ""} className="min-w-48">
        <option value="">Not assigned</option>
        {clients.map((client) => (
          <option key={client.id} value={client.id}>{client.name}</option>
        ))}
      </NativeSelect>
      <Button type="submit" variant="secondary" size="sm">Save</Button>
    </ActionForm>
  );

  const nameCell = (row: CostRow) => (
    <div className="min-w-0">
      <p className="truncate font-medium">{lineTitle(row)}</p>
      {row.domainName ? <p className="truncate text-meta text-muted-foreground">{row.name}</p> : null}
    </div>
  );

  const priceColumn: DataListColumn<CostRow> = {
    key: "price",
    header: "Per renewal",
    cell: (row) => supplierMoney(row.renewalPrice, row.currencyCode),
    numeric: true,
  };
  const renewsColumn: DataListColumn<CostRow> = {
    key: "renews",
    header: "Renews",
    cell: (row) => (row.nextBillingAt ? formatDate(row.nextBillingAt) : "—"),
    hideOnMobile: true,
  };

  const unassignedColumns: DataListColumn<CostRow>[] = [
    { key: "name", header: "Subscription", cell: nameCell, primary: true },
    priceColumn,
    renewsColumn,
    {
      key: "state",
      header: "State",
      cell: (row) => <StatusBadge value={row.status === "in_trial" ? "trial" : row.status.replaceAll("_", " ")} />,
      status: true,
    },
    { key: "assign", header: "Assign to", cell: assignCell, action: true },
  ];

  const everyColumns: DataListColumn<CostRow>[] = [
    { key: "name", header: "Subscription", cell: nameCell, primary: true },
    { key: "client", header: "Client", cell: (row) => row.clientName ?? "—" },
    priceColumn,
    renewsColumn,
    {
      key: "match",
      header: "How",
      cell: (row) => <StatusBadge value={MATCH_LABEL[row.match]} />,
      status: true,
    },
    { key: "assign", header: "Change", cell: assignCell, action: true },
  ];

  return (
    <>
      <PageHeader
        wide
        title="Costs"
        description="What we pay suppliers, and which client each one is for."
        category="money"
        actions={
          <ActionForm action={syncCostsAction} success="Synced from the supplier" ariaLabel="Sync costs">
            <Button type="submit" variant="secondary">Sync now</Button>
          </ActionForm>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Per renewal"
          value={totalsByCurrency(live)}
          hint={`${live.length} live subscription${live.length === 1 ? "" : "s"}`}
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
        {/* Amber, and only when there is something to be amber about. A trial
            set to auto-renew is the one thing here with a deadline. */}
        <StatCard
          label="Trials that will charge"
          value={trials.length}
          hint={trials.length === 0 ? "None on trial" : totalsByCurrency(trials)}
          category="money"
          icon={TriangleAlert}
          attention={trials.length > 0}
          attentionTone="warning"
        />
        <StatCard
          label="Not assigned"
          value={unassigned.length}
          hint={
            unassigned.length === 0
              ? "Everything is attributed"
              : `${totalsByCurrency(unassigned)} against no client`
          }
          category="money"
          icon={CircleHelp}
          attention={unassigned.length > 0}
          attentionTone="warning"
        />
        <StatCard
          label="Attributed"
          value={clientGroups.length}
          hint={`${attributed.length} line${attributed.length === 1 ? "" : "s"} across ${clientGroups.length} client${clientGroups.length === 1 ? "" : "s"}`}
          category="delivery"
          icon={Users}
        />
      </div>

      {/* Trials first: the only thing on this screen with a date attached. One
          table that names every subscription, rather than a slab of amber that
          names none. */}
      {trials.length > 0 ? (
        <Section
          title="Trials that will start charging"
          description="These renew automatically. Cancel them at the supplier or they become a bill."
        >
          <DataList
            rows={trials}
            columns={unassignedColumns}
            getRowKey={(row) => row.id}
            caption="Trial subscriptions that will renew"
          />
        </Section>
      ) : null}

      {unassigned.length > 0 ? (
        <Section
          title="Not assigned to a client"
          description="Their cost counts against nobody's margin until it is. A confirmed answer is never overwritten by a sync."
        >
          <DataList
            rows={unassigned}
            columns={unassignedColumns}
            getRowKey={(row) => row.id}
            caption="Subscriptions with no client"
          />
        </Section>
      ) : null}

      {clientGroups.length > 0 ? (
        <Section title="What each client costs" description="Per renewal, in the supplier's own currency.">
          <DataList
            rows={clientGroups}
            columns={[
              {
                key: "client",
                header: "Client",
                primary: true,
                cell: (group) => (
                  <Link href={`/clients/${group.clientId}`} className="font-medium hover:underline">
                    {group.name}
                  </Link>
                ),
              },
              { key: "lines", header: "Subscriptions", cell: (group) => group.rows.length, numeric: true },
              {
                key: "what",
                header: "What for",
                hideOnMobile: true,
                cell: (group) => (
                  <span className="text-muted-foreground">
                    {group.rows.map(lineTitle).slice(0, 3).join(", ")}
                    {group.rows.length > 3 ? ` +${group.rows.length - 3}` : ""}
                  </span>
                ),
              },
              { key: "total", header: "Per renewal", cell: (group) => totalsByCurrency(group.rows), numeric: true },
            ]}
            getRowKey={(group) => group.clientId}
            caption="Cost per client"
          />
        </Section>
      ) : null}

      <Section title="Every subscription" description="The full list, whatever state it is in.">
        {costs.length === 0 ? (
          <EmptyState icon={Wallet}>
            Nothing synced yet. Press Sync now, or wait for the nightly job — it needs HOSTINGER_API_TOKEN.
          </EmptyState>
        ) : (
          <DataList
            rows={costs}
            columns={everyColumns}
            getRowKey={(row) => row.id}
            caption="Every supplier subscription"
          />
        )}
      </Section>
    </>
  );
}
