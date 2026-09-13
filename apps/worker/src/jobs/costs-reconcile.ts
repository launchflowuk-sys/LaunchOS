import { meteredForMonth, notifyOwner, reconcileSupplier, syncStripeFees, type ReconcileResult } from "@launchos/core";
import type { Db } from "@launchos/db";
import { openAiMonthlyCost, type PaymentsAdapter } from "@launchos/integrations";

/**
 * Nightly: pull Stripe's fees in, then check the ledger against the real bills.
 *
 * Two jobs in one pass because they answer the same question — is what we
 * think we spent what we actually spent — and because running them apart means
 * reconciling a month whose fees have not landed yet.
 *
 * **Per provider, and a missing credential is never a clean bill of health.**
 * OpenAI has an admin key; Anthropic's equivalent is Team/Enterprise only, so
 * that one reports `not_reconciled` until somebody pastes the Console CSV. The
 * owner is only told about a real gap, never about a provider we could not ask
 * — a nightly "could not check" would be noise that teaches him to ignore the
 * bell.
 */

export interface CostsReconcileDeps {
  db: Db;
  payments?: PaymentsAdapter;
  logger: Console;
  env?: NodeJS.ProcessEnv;
}

export interface CostsReconcileJob {
  organisationId: string;
}

export async function handleCostsReconcile(deps: CostsReconcileDeps, job: CostsReconcileJob) {
  const env = deps.env ?? process.env;
  const now = new Date();

  // Fees first: reconciling Stripe before its own fees are in would report a
  // gap that is really just a stale ledger.
  let fees = { reported: 0, recorded: 0 };
  if (deps.payments) {
    try {
      const result = await syncStripeFees(deps.db, job.organisationId, deps.payments, now);
      fees = { reported: result.reported, recorded: result.recorded };
    } catch (error) {
      deps.logger.warn("[costs.reconcile] stripe fees could not be read", { error });
    }
  }

  const results: ReconcileResult[] = [];

  // OpenAI: the one provider with a usage API we hold a key for.
  const openAi = await openAiMonthlyCost(now, { adminKey: env.OPENAI_ADMIN_KEY ?? "" });
  results.push(
    await reconcileSupplier(
      deps.db,
      job.organisationId,
      openAi
        ? { supplier: "openai", billedMinor: openAi.cents, billedCurrency: "USD" }
        : { supplier: "openai", billedMinor: null, note: "no OPENAI_ADMIN_KEY, so the bill was not read" },
      now,
    ),
  );

  // Anthropic: admin keys are Team/Enterprise only, so there is nothing to
  // call. Recorded as unchecked rather than skipped, so the screen can say so.
  results.push(
    await reconcileSupplier(
      deps.db,
      job.organisationId,
      {
        supplier: "anthropic",
        billedMinor: null,
        note: "admin keys are Team/Enterprise only — import the Console cost CSV on Settings → Costs",
      },
      now,
    ),
  );

  // Stripe needs no reconciling: the fee figures *are* Stripe's own, so
  // comparing them to themselves would always match and mean nothing.
  const stripeMetered = await meteredForMonth(deps.db, job.organisationId, "stripe", now);

  const gaps = results.filter((result) => result.status === "gap");
  for (const gap of gaps) {
    await notifyOwner(deps.db, job.organisationId, {
      kind: "costs.reconcile_gap",
      title: `${gap.supplier}: the bill and the ledger disagree`,
      body: `${gap.month} — metered £${(gap.meteredPence / 100).toFixed(2)}, billed £${((gap.billedPence ?? 0) / 100).toFixed(2)}. ${gap.note}`,
      link: "/profit",
    }).catch(() => undefined);
  }

  deps.logger.info("[costs.reconcile] done", {
    organisationId: job.organisationId,
    feesReported: fees.reported,
    feesRecorded: fees.recorded,
    stripeMeteredPence: stripeMetered,
    results: results.map((r) => `${r.supplier}:${r.status}${r.gapPercent === null ? "" : `:${r.gapPercent}%`}`),
  });

  return { fees, results };
}
