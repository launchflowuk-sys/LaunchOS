import {
  computeAccountSignals, CPC_RISE_THRESHOLD_PERCENT, listAdAccounts, listClients, ROAS_DROP_THRESHOLD_PERCENT,
} from "@launchos/core";
import { Megaphone } from "lucide-react";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { NativeSelect } from "@/components/ui/native-select";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDb } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";
import { addAdAccount } from "./actions";

export const dynamic = "force-dynamic";

/**
 * A percentage change, signed, coloured red only once it is past the signal
 * threshold — or an em dash when there is no window to compare against.
 *
 * `deltaPercent` returns 0 with no previous window, which is the right call for
 * the flagging logic (core deliberately does not flag an account with no prior
 * week). Printing that 0 as "+0.0%" says "nothing changed" about an account
 * that has nothing to change from, and hides a real week-one collapse.
 */
function Delta({
  percent, threshold, direction, hasBaseline,
}: { percent: number; threshold: number; direction: "drop" | "rise"; hasBaseline: boolean }) {
  if (!hasBaseline) {
    return (
      <span className="text-muted-foreground" title="No previous week to compare against">
        —
      </span>
    );
  }
  const bad = direction === "drop" ? percent < -threshold : percent > threshold;
  return (
    <span className={cn("tabular-nums", bad ? "font-medium text-danger-fg" : "text-muted-foreground")}>
      {percent > 0 ? "+" : ""}
      {percent.toFixed(1)}%
    </span>
  );
}

/** The most accounts one screen will render; past this, the list is paginated work. */
const MAX_ACCOUNTS = 100;

type AccountRow = {
  account: Awaited<ReturnType<typeof listAdAccounts>>[number];
  signals: Awaited<ReturnType<typeof computeAccountSignals>>;
};

const COLUMNS: readonly DataListColumn<AccountRow>[] = [
  {
    key: "account",
    header: "Account",
    primary: true,
    cell: ({ account }) => (
      <>
        <Link href={`/ads/${account.id}`} className="hover:underline">
          {account.name}
        </Link>
        <span className="block text-meta font-normal text-muted-foreground">{account.externalId}</span>
      </>
    ),
  },
  {
    key: "client",
    header: "Client",
    cell: ({ account }) => (
      <Link href={`/clients/${account.clientId}`} className="hover:underline">
        {account.clientName}
      </Link>
    ),
  },
  { key: "platform", header: "Platform", cell: ({ account }) => <span className="capitalize">{account.platform}</span> },
  {
    key: "spend",
    header: "7-day spend",
    numeric: true,
    className: "font-medium text-foreground",
    cell: ({ account, signals }) => formatMoney(signals.current.spendPence, account.currency),
  },
  {
    key: "roas",
    header: "ROAS",
    numeric: true,
    cell: ({ signals }) =>
      signals.current.days === 0 ? (
        <span className="text-muted-foreground" title="No metrics collected for this week yet">
          —
        </span>
      ) : (
        signals.current.roas.toFixed(2)
      ),
  },
  {
    key: "roasChange",
    header: "ROAS change",
    numeric: true,
    hideOnMobile: true,
    cell: ({ signals }) => (
      <Delta
        percent={signals.roasDeltaPercent}
        threshold={ROAS_DROP_THRESHOLD_PERCENT}
        direction="drop"
        hasBaseline={signals.previous.days > 0}
      />
    ),
  },
  {
    key: "cpcChange",
    header: "CPC change",
    numeric: true,
    hideOnMobile: true,
    cell: ({ signals }) => (
      <Delta
        percent={signals.cpcDeltaPercent}
        threshold={CPC_RISE_THRESHOLD_PERCENT}
        direction="rise"
        hasBaseline={signals.previous.days > 0}
      />
    ),
  },
  { key: "accountStatus", header: "Account", cell: ({ account }) => <StatusBadge value={account.status} /> },
  {
    key: "signal",
    header: "Signal",
    status: true,
    cell: ({ signals }) => (
      <StatusBadge value={signals.flagged ? "flagged" : "steady"} tone={signals.flagged ? "danger" : "success"} />
    ),
  },
];

export default async function AdsPage() {
  const session = await requireAdmin();
  const db = getDb();

  // Each account costs three queries in computeAccountSignals, all fired at
  // once against a pool of ten, on a force-dynamic page. Bounded so the page
  // degrades into "the first hundred by client" rather than into a timeout.
  const [accounts, clients] = await Promise.all([
    listAdAccounts(db, session.organisationId, { limit: MAX_ACCOUNTS }),
    listClients(db, session.organisationId, { status: "active" }),
  ]);

  const now = new Date();
  const rows: AccountRow[] = await Promise.all(
    accounts.map(async (account) => ({
      account,
      signals: await computeAccountSignals(db, session.organisationId, account.id, { now }),
    })),
  );

  return (
    <>
      <PageHeader
        title="Ads"
        description="Google and Meta accounts, and how the last week compares with the one before."
        category="money"
      />

      <Section title="Add an ad account">
        {clients.length === 0 ? (
          <EmptyState>
            No active clients yet. Create one under <Link href="/clients" className="underline">Clients</Link> first.
          </EmptyState>
        ) : (
          <ActionForm
            action={addAdAccount}
            ariaLabel="Add an ad account"
            success="Ad account added"
            resetOnSuccess
            className="space-y-4 rounded-xl border bg-card p-4"
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="ads-client">Client</Label>
                <NativeSelect id="ads-client" name="clientId" required defaultValue="">
                  <option value="" disabled>
                    Choose a client
                  </option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ads-platform">Platform</Label>
                <NativeSelect id="ads-platform" name="platform" defaultValue="google">
                  <option value="google">Google</option>
                  <option value="meta">Meta</option>
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ads-external-id">Account id</Label>
                <Input id="ads-external-id" name="externalId" required maxLength={120} placeholder="123-456-7890" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ads-name">Account name</Label>
                <Input id="ads-name" name="name" required maxLength={200} placeholder="Search — brand" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ads-currency">Currency</Label>
                <Input
                  id="ads-currency"
                  name="currency"
                  maxLength={3}
                  pattern="[A-Za-z]{3}"
                  title="A three-letter currency code, such as GBP"
                  defaultValue="GBP"
                />
              </div>
            </div>
            <div className="flex justify-end max-sm:[&>*]:w-full">
              <Button type="submit">Add ad account</Button>
            </div>
          </ActionForm>
        )}
      </Section>

      <Section title="Accounts">
        <DataList
          rows={rows}
          columns={COLUMNS}
          getRowKey={({ account }) => account.id}
          caption="Ad accounts"
          empty={
            <EmptyState icon={Megaphone}>
              No ad accounts yet. Add one above to start collecting daily metrics.
            </EmptyState>
          }
        />
      </Section>
    </>
  );
}
