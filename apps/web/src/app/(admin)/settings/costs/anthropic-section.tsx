"use client";

import { Upload } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { importAnthropicCostAction, type AnthropicReadResult } from "./register-actions";

/**
 * Reading what Anthropic actually billed.
 *
 * The Usage and Cost API needs an **admin key**, and those are only issued to
 * Team and Enterprise organisations — on an individual account the endpoint
 * does not exist, so there is nothing to automate against. The Console's CSV
 * export carries the same figures, and reconciliation is a monthly job, so a
 * monthly paste is barely worse than a monthly API call.
 *
 * A client component with `useActionState` rather than the shared
 * `ActionForm`: that wrapper shows a fixed success message and throws the
 * action's payload away, and the payload is the entire point here. The numbers
 * render below the form.
 *
 * Read-only, and it says so. It writes nothing, because the usage ledger it
 * would write into does not exist; claiming to have "imported" would be a lie.
 */

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function Breakdown({ title, rows }: { title: string; rows: { label: string; cents: number }[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</p>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-slate-100">
              <td className="py-1.5 text-slate-700">{row.label}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-900">{usd(row.cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnthropicImportSection() {
  const [state, formAction, pending] = useActionState<AnthropicReadResult | null, FormData>(
    importAnthropicCostAction,
    null,
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">Anthropic cost export</h2>
      <p className="mt-1 text-sm text-slate-600">
        Check what Claude actually cost against what the register says. Admin keys are Team/Enterprise only, so this
        reads the CSV from console.anthropic.com → Settings → Cost.
      </p>

      <form action={formAction} className="mt-4 flex flex-col gap-3" aria-label="Read an Anthropic cost export">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            className="text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-200 file:bg-white file:px-3 file:py-1.5 file:text-sm file:text-slate-700"
            aria-label="Cost export CSV"
          />
          <Button type="submit" variant="secondary" disabled={pending}>
            <Upload className="size-4" aria-hidden /> {pending ? "Reading…" : "Read the file"}
          </Button>
        </div>
        <details className="text-sm text-slate-600">
          <summary className="cursor-pointer">Or paste the CSV</summary>
          <textarea
            name="csv"
            rows={4}
            placeholder="usage_date_utc,model,workspace,api_key,…"
            className="mt-2 w-full rounded-md border border-slate-200 bg-white p-2.5 font-mono text-xs text-slate-900 focus:border-slate-400 focus:outline-none"
          />
        </details>
      </form>

      {state?.status === "error" ? (
        <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {state.message}
        </p>
      ) : null}

      {state?.status === "ok" ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm text-slate-900">
            <strong className="text-lg tabular-nums">{usd(state.totalCents)}</strong> across {state.rows} priced rows,{" "}
            {state.firstDay} to {state.lastDay}.
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Breakdown title="By business" rows={state.byBusiness} />
            <Breakdown title="By model" rows={state.byModel.map((r) => ({ label: r.model, cents: r.cents }))} />
            <Breakdown
              title="Unmatched keys"
              rows={state.unmatched.map((r) => ({ label: r.apiKey, cents: r.cents }))}
            />
          </div>
          {state.unmatched.length > 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              An unmatched key is left unattributed on purpose. A mis-attributed cost is worse than an unattributed one
              — nobody goes looking for a number that already has an owner.
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-slate-500">
        Nothing is stored. It reports the total, the date range and the split by API key — the keys already name the
        business, so no tagging is needed. Storing it belongs with the usage ledger, which is not built.
      </p>
    </section>
  );
}
