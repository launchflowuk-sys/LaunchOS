import {
  computeAccountSignals, CPC_RISE_THRESHOLD_PERCENT, listAdAccounts, listClients, ROAS_DROP_THRESHOLD_PERCENT,
} from "@launchos/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";
import { addAdAccount } from "./actions";

export const dynamic = "force-dynamic";

const FIELD = "mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";
const LABEL = "block text-xs font-medium text-neutral-500";

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
      <span className="text-neutral-400" title="No previous week to compare against">
        —
      </span>
    );
  }
  const bad = direction === "drop" ? percent < -threshold : percent > threshold;
  return (
    <span className={cn("tabular-nums", bad ? "text-red-600" : "text-neutral-600")}>
      {percent > 0 ? "+" : ""}
      {percent.toFixed(1)}%
    </span>
  );
}

/** The most accounts one screen will render; past this, the list is paginated work. */
const MAX_ACCOUNTS = 100;

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
  const rows = await Promise.all(
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
      />

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Add an ad account</h2>
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
            className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className={LABEL}>
                Client
                <select name="clientId" required defaultValue="" className={FIELD}>
                  <option value="" disabled>
                    Choose a client
                  </option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL}>
                Platform
                <select name="platform" defaultValue="google" className={FIELD}>
                  <option value="google">Google</option>
                  <option value="meta">Meta</option>
                </select>
              </label>
              <label className={LABEL}>
                Account id
                <input name="externalId" required maxLength={120} placeholder="123-456-7890" className={FIELD} />
              </label>
              <label className={LABEL}>
                Account name
                <input name="name" required maxLength={200} placeholder="Search — brand" className={FIELD} />
              </label>
              <label className={LABEL}>
                Currency
                <input
                  name="currency"
                  maxLength={3}
                  pattern="[A-Za-z]{3}"
                  title="A three-letter currency code, such as GBP"
                  defaultValue="GBP"
                  className={FIELD}
                />
              </label>
            </div>
            <div className="flex justify-end">
              <Button type="submit">Add ad account</Button>
            </div>
          </ActionForm>
        )}
      </section>

      {rows.length === 0 ? (
        <EmptyState>No ad accounts yet. Add one above to start collecting daily metrics.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">7-day spend</TableHead>
                <TableHead className="text-right">ROAS</TableHead>
                <TableHead className="text-right">ROAS change</TableHead>
                <TableHead className="text-right">CPC change</TableHead>
                <TableHead>Signal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ account, signals }) => (
                <TableRow key={account.id}>
                  <TableCell>
                    <Link href={`/ads/${account.id}`} className="font-medium text-neutral-900 hover:underline">
                      {account.name}
                    </Link>
                    <span className="block text-xs text-neutral-400">{account.externalId}</span>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    <Link href={`/clients/${account.clientId}`} className="hover:underline">
                      {account.clientName}
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize text-neutral-600">{account.platform}</TableCell>
                  <TableCell>
                    <StatusBadge value={account.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-900">
                    {formatMoney(signals.current.spendPence, account.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-900">
                    {signals.current.days === 0 ? (
                      <span className="text-neutral-400" title="No metrics collected for this week yet">
                        —
                      </span>
                    ) : (
                      signals.current.roas.toFixed(2)
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Delta
                      percent={signals.roasDeltaPercent}
                      threshold={ROAS_DROP_THRESHOLD_PERCENT}
                      direction="drop"
                      hasBaseline={signals.previous.days > 0}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Delta
                      percent={signals.cpcDeltaPercent}
                      threshold={CPC_RISE_THRESHOLD_PERCENT}
                      direction="rise"
                      hasBaseline={signals.previous.days > 0}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      value={signals.flagged ? "flagged" : "steady"}
                      tone={signals.flagged ? "danger" : "success"}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
