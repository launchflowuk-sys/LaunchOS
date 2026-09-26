import {
  BUSINESS_LABELS,
  COST_BUSINESSES,
  COST_SUPPLIERS,
  VAT_TREATMENT_LABELS,
  VAT_TREATMENTS,
  type RegisterEntry,
} from "@launchos/core";
import { Plus, Trash2 } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { formatDate } from "@/lib/format";
import { deleteCostAction, prefillCostsAction, setFxRateAction, upsertCostAction } from "./register-actions";

/**
 * The register: the subscriptions and fixed costs a person types in.
 *
 * Separate from the synced rows above it on the same screen, because the two
 * behave differently and a table that mixed them would have to explain, per
 * row, why some cells are editable and some are not.
 */

const INPUT =
  "h-9 w-full rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none";

function money(minor: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  return `${symbol}${(minor / 100).toFixed(2)}${symbol ? "" : ` ${currency}`}`;
}

function SupplierOptions() {
  return (
    <>
      {COST_SUPPLIERS.map((supplier) => (
        <option key={supplier} value={supplier}>
          {supplier}
        </option>
      ))}
    </>
  );
}

function BusinessOptions() {
  return (
    <>
      {COST_BUSINESSES.map((business) => (
        <option key={business} value={business}>
          {BUSINESS_LABELS[business]}
        </option>
      ))}
    </>
  );
}

function VatOptions() {
  return (
    <>
      {VAT_TREATMENTS.map((treatment) => (
        <option key={treatment} value={treatment}>
          {VAT_TREATMENT_LABELS[treatment]}
        </option>
      ))}
    </>
  );
}

/** One editable row. Manual rows can change everything; synced rows only what the sync cannot know. */
function Row({ row, hasSyncedHetzner }: { row: RegisterEntry; hasSyncedHetzner: boolean }) {
  const synced = row.source === "sync";
  const isHetzner = row.supplier === "hetzner";
  return (
    <tr className="border-t border-slate-100 align-middle">
      <td className="px-3 py-2">
        <ActionForm
          action={upsertCostAction}
          success={`Saved ${row.name}`}
          ariaLabel={`Edit ${row.name}`}
          className="grid grid-cols-[minmax(0,1.6fr)_110px_90px_70px_90px_150px_150px_auto] items-center gap-2"
        >
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="status" value={row.status} />
          {synced ? (
            <>
              <span className="truncate text-sm text-slate-900" title={row.name}>
                {row.name}
              </span>
              <input type="hidden" name="supplier" value={row.supplier} />
              <input type="hidden" name="name" value={row.name} />
              <input type="hidden" name="amount" value={(row.renewalPrice / 100).toFixed(2)} />
              <input type="hidden" name="currencyCode" value={row.currencyCode} />
              <input type="hidden" name="billingPeriod" value={row.billingPeriod} />
              <input type="hidden" name="billingPeriodUnit" value={row.billingPeriodUnit} />
              <span className="text-xs text-slate-500">{row.supplier}</span>
              <span className="text-sm text-slate-900">{money(row.renewalPrice, row.currencyCode)}</span>
              <span className="text-xs text-slate-500">{row.currencyCode}</span>
              <span className="text-xs text-slate-500">
                /{row.billingPeriod > 1 ? `${row.billingPeriod} ` : ""}
                {row.billingPeriodUnit}
              </span>
            </>
          ) : (
            <>
              <input name="name" defaultValue={row.name} className={INPUT} aria-label="Name" />
              <NativeSelect name="supplier" defaultValue={row.supplier} aria-label="Supplier">
                <SupplierOptions />
              </NativeSelect>
              <input
                name="amount"
                defaultValue={row.renewalPrice === 0 ? "" : (row.renewalPrice / 100).toFixed(2)}
                placeholder="0.00"
                inputMode="decimal"
                className={INPUT}
                aria-label="Amount"
              />
              <input name="currencyCode" defaultValue={row.currencyCode} className={INPUT} aria-label="Currency" maxLength={3} />
              <NativeSelect name="billingPeriodUnit" defaultValue={row.billingPeriodUnit} aria-label="Per">
                <option value="month">per month</option>
                <option value="year">per year</option>
                <option value="week">per week</option>
                <option value="day">per day</option>
              </NativeSelect>
              <input type="hidden" name="billingPeriod" value={row.billingPeriod} />
            </>
          )}
          {synced && isHetzner ? (
            <>
              <input type="hidden" name="business" value={row.business} />
              <span className="text-xs text-slate-400">Set on Servers</span>
            </>
          ) : (
            <NativeSelect name="business" defaultValue={row.business} aria-label="Business">
              <BusinessOptions />
            </NativeSelect>
          )}
          <NativeSelect name="vatTreatment" defaultValue={row.vatTreatment} aria-label="VAT">
            <VatOptions />
          </NativeSelect>
          <Button type="submit" variant="secondary" className="h-9">
            Save
          </Button>
        </ActionForm>
        {row.notes ? <p className="mt-1 pl-1 text-xs text-slate-500">{row.notes}</p> : null}
        {!synced && isHetzner && hasSyncedHetzner ? (
          <p className="mt-1 pl-1 text-xs text-amber-700">
            Now synced per server — this hand-typed line probably double-counts. Delete it if so.
          </p>
        ) : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500">
        {row.nextBillingAt ? formatDate(row.nextBillingAt) : "—"}
      </td>
      <td className="px-3 py-2 text-right">
        {synced ? (
          <span className="text-xs text-slate-400">synced</span>
        ) : (
          <ActionForm action={deleteCostAction} success={`Removed ${row.name}`} ariaLabel={`Remove ${row.name}`}>
            <input type="hidden" name="costId" value={row.id} />
            <Button type="submit" variant="ghost" className="h-8 px-2 text-slate-500">
              <Trash2 className="size-4" aria-hidden />
              <span className="sr-only">Remove</span>
            </Button>
          </ActionForm>
        )}
      </td>
    </tr>
  );
}

export function RegisterSection({
  rows,
  missingRateCurrencies,
}: {
  rows: readonly RegisterEntry[];
  missingRateCurrencies: readonly string[];
}) {
  const unpriced = rows.filter((row) => row.renewalPrice === 0 && row.status !== "cancelled").length;
  const hasSyncedHetzner = rows.some((row) => row.source === "sync" && row.supplier === "hetzner");

  return (
    <Section
      title="The register"
      description="Every subscription and fixed cost, with the business that pays for it and how VAT sits on the invoice. Amounts are net — what the supplier charges before VAT."
      actions={
        <ActionForm action={prefillCostsAction} success="Register seeded" ariaLabel="Add known suppliers">
          <Button type="submit" variant="secondary">
            <Plus className="size-4" aria-hidden /> Add known suppliers
          </Button>
        </ActionForm>
      }
    >
      {unpriced > 0 ? (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>{unpriced}</strong> {unpriced === 1 ? "line has" : "lines have"} no price yet, so{" "}
          {unpriced === 1 ? "it counts" : "they count"} as nothing on the Profit screen. Fill them in as you find the
          invoices.
        </p>
      ) : null}

      {missingRateCurrencies.length > 0 ? (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <p className="mb-2">
            No exchange rate for <strong>{missingRateCurrencies.join(", ")}</strong>. Those rows are left out of the
            totals rather than converted at a guess — a missing rate treated as parity turns $500 into £500 and looks
            plausible.
          </p>
          {missingRateCurrencies.map((currency) => (
            <ActionForm
              key={currency}
              action={setFxRateAction}
              success={`Rate saved for ${currency}`}
              ariaLabel={`Set the ${currency} rate`}
              className="mt-1.5 flex items-center gap-2"
            >
              <input type="hidden" name="base" value={currency} />
              <label className="text-xs" htmlFor={`rate-${currency}`}>
                1 {currency} = £
              </label>
              <input
                id={`rate-${currency}`}
                name="rate"
                placeholder="0.7850"
                inputMode="decimal"
                className={`${INPUT} w-28`}
              />
              <Button type="submit" variant="secondary" className="h-9">
                Save rate
              </Button>
            </ActionForm>
          ))}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] border-collapse text-left">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 pb-2 font-medium">Cost · supplier · amount · business · VAT</th>
              <th className="px-3 pb-2 text-right font-medium">Renews</th>
              <th className="px-3 pb-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={row.id} row={row} hasSyncedHetzner={hasSyncedHetzner} />
            ))}
            <tr className="border-t-2 border-slate-200">
              <td className="px-3 py-3" colSpan={3}>
                <ActionForm
                  action={upsertCostAction}
                  success="Added"
                  ariaLabel="Add a cost"
                  className="grid grid-cols-[minmax(0,1.6fr)_110px_90px_70px_90px_150px_150px_auto] items-center gap-2"
                >
                  <input name="name" placeholder="What it is" required className={INPUT} aria-label="Name" />
                  <NativeSelect name="supplier" defaultValue="other" aria-label="Supplier">
                    <SupplierOptions />
                  </NativeSelect>
                  <input name="amount" placeholder="0.00" inputMode="decimal" className={INPUT} aria-label="Amount" />
                  <input name="currencyCode" defaultValue="GBP" className={INPUT} aria-label="Currency" maxLength={3} />
                  <NativeSelect name="billingPeriodUnit" defaultValue="month" aria-label="Per">
                    <option value="month">per month</option>
                    <option value="year">per year</option>
                    <option value="week">per week</option>
                    <option value="day">per day</option>
                  </NativeSelect>
                  <NativeSelect name="business" defaultValue="launchflow" aria-label="Business">
                    <BusinessOptions />
                  </NativeSelect>
                  <NativeSelect name="vatTreatment" defaultValue="none" aria-label="VAT">
                    <VatOptions />
                  </NativeSelect>
                  <input type="hidden" name="billingPeriod" value="1" />
                  <input type="hidden" name="status" value="active" />
                  <Button type="submit" className="h-9">
                    Add
                  </Button>
                </ActionForm>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Section>
  );
}
