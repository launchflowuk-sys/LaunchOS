import { listSuppressions } from "@launchos/core";
import { ShieldOff } from "lucide-react";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { addSuppressionAction, removeSuppressionAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Blocked numbers" };

/**
 * The numbers an inbound text must never turn into a lead.
 *
 * A number Shoji advertises also carries his family, his drivers and his
 * existing clients. Everything downstream of a lead is machinery — a sales
 * reply is drafted, the owner's bell rings, it lands on the board — and none of
 * that should start because his wife texted. This is where that is said.
 */
export default async function BlockedNumbersPage() {
  const session = await requireAdmin();
  const rows = await listSuppressions(getDb(), session.organisationId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Blocked numbers"
        description="A text from one of these never becomes a lead, and never gets a reply drafted. Family, drivers, existing clients — anyone who messages the business number but is not new business."
        actions={
          <Button asChild variant="secondary">
            <Link href="/leads">All leads</Link>
          </Button>
        }
      />

      <ActionForm
        action={addSuppressionAction}
        ariaLabel="Block a number"
        success="Number blocked"
        resetOnSuccess
        className="grid gap-3 rounded-[20px] border bg-card p-5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] sm:items-end"
      >
        <div className="space-y-1.5">
          <Label htmlFor="blocked-phone">Number</Label>
          <Input id="blocked-phone" name="phone" inputMode="tel" placeholder="07700 900123" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="blocked-note">Who is it? (optional)</Label>
          <Input id="blocked-note" name="note" maxLength={200} placeholder="Shumaila" />
        </div>
        <Button type="submit" variant="secondary" className="max-sm:w-full">
          Block
        </Button>
      </ActionForm>

      {rows.length === 0 ? (
        <EmptyState icon={ShieldOff} title="No blocked numbers">
          Add one before you advertise the number anywhere — it is easier than doing it
          after you have explained a sales text to somebody you know.
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-[20px] border bg-card">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-medium tabular-nums">{row.phone}</p>
                <p className="text-sm text-muted-foreground">
                  {row.note ? `${row.note} — ` : ""}
                  blocked {formatDateTime(row.createdAt)}
                </p>
              </div>
              <ActionForm action={removeSuppressionAction} ariaLabel={`Unblock ${row.phone}`} success="Number unblocked">
                <input type="hidden" name="id" value={row.id} />
                <Button type="submit" variant="ghost" size="sm">
                  Unblock
                </Button>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
