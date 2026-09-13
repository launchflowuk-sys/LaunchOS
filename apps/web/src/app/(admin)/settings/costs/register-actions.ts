"use server";

import {
  BUSINESS_LABELS,
  centsByBusiness,
  type CostBusiness,
  deleteCost,
  parseAnthropicCostCsv,
  prefillRegister,
  setFxRate,
  upsertCost,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

/**
 * The register half of the Costs screen — the rows a person types in.
 *
 * Separate from `actions.ts`, which owns the supplier sync and the
 * client attribution. Two files rather than one 400-line one, and the split
 * follows the real seam: one side is what a supplier's API says, the other is
 * what Shoji says.
 */

type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

const UpsertInput = z.object({
  id: z.union([z.literal(""), z.string().uuid()]).optional(),
  supplier: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  business: z.string().min(1),
  /** Typed in pounds or dollars, because that is what an invoice shows. */
  amount: z.string().trim(),
  currencyCode: z.string().trim().length(3),
  billingPeriod: z.coerce.number().int().min(1).max(60).default(1),
  billingPeriodUnit: z.enum(["day", "week", "month", "year"]),
  vatTreatment: z.enum(["standard", "reverse_charge", "exempt", "none"]),
  status: z.string().trim().min(1).max(40).default("active"),
  notes: z.union([z.literal(""), z.string().max(2000)]).optional(),
});

/**
 * `24.50` → `2450`. Currency symbols and thousands separators are stripped
 * because people paste figures straight off a bill. A blank is zero, which is
 * how an unpriced row is recorded rather than refused.
 */
function toMinor(raw: string): number | null {
  const cleaned = raw.replace(/[£$€,\s]/g, "");
  if (cleaned.length === 0) return 0;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Adding or correcting a line in the register. */
export async function upsertCostAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };

  const parsed = UpsertInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: "error", message: "Check the fields and try again" };
  const minor = toMinor(parsed.data.amount);
  if (minor === null) return { status: "error", message: "That amount could not be read" };

  try {
    const row = await upsertCost(getDb(), gate.session.organisationId, {
      ...(parsed.data.id ? { id: parsed.data.id } : {}),
      supplier: parsed.data.supplier as never,
      name: parsed.data.name,
      business: parsed.data.business as never,
      renewalPrice: minor,
      currencyCode: parsed.data.currencyCode,
      billingPeriod: parsed.data.billingPeriod,
      billingPeriodUnit: parsed.data.billingPeriodUnit,
      vatTreatment: parsed.data.vatTreatment,
      status: parsed.data.status,
      notes: parsed.data.notes ? parsed.data.notes : null,
      actorId: gate.session.userId,
    });
    revalidatePath("/settings/costs");
    revalidatePath("/profit");
    return { status: "ok", id: row.id };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not save that" };
  }
}

/** Removes a typed-in line. A synced line refuses — the sync would bring it straight back. */
export async function deleteCostAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const costId = z.string().uuid().safeParse(formData.get("costId"));
  if (!costId.success) return { status: "error", message: "That cost could not be identified" };

  try {
    await deleteCost(getDb(), gate.session.organisationId, costId.data, gate.session.userId);
    revalidatePath("/settings/costs");
    revalidatePath("/profit");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not remove that" };
  }
}

/**
 * Seeds the register with every supplier the code already knows it talks to,
 * priced at zero. Correcting a list beats remembering one, and a second run
 * adds nothing.
 */
export async function prefillCostsAction(): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  try {
    const { added } = await prefillRegister(getDb(), gate.session.organisationId, gate.session.userId);
    revalidatePath("/settings/costs");
    revalidatePath("/profit");
    return { status: "ok", id: added === 0 ? "Nothing missing" : `${added} added — now set the prices` };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not prefill" };
  }
}

const FxInput = z.object({ base: z.string().trim().length(3), rate: z.coerce.number().positive().max(1000) });

/**
 * Records a currency's rate for this month.
 *
 * Dated to the first of the month, which is what `profitReport` looks up — a
 * rate entered on the 20th still has to apply to the month being reported.
 * Stored per day so a closed month never changes.
 */
export async function setFxRateAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = FxInput.safeParse({ base: formData.get("base"), rate: formData.get("rate") });
  if (!parsed.success) return { status: "error", message: "That rate could not be read" };

  try {
    const now = new Date();
    await setFxRate(getDb(), gate.session.organisationId, {
      day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      base: parsed.data.base,
      rate: parsed.data.rate,
      source: "manual",
    });
    revalidatePath("/settings/costs");
    revalidatePath("/profit");
    return { status: "ok", id: `1 ${parsed.data.base} = £${parsed.data.rate}` };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not save that rate" };
  }
}

/** What the Anthropic reader hands back, so the screen can render a breakdown rather than a toast. */
export type AnthropicReadResult =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "ok";
      totalCents: number;
      rows: number;
      firstDay: string | null;
      lastDay: string | null;
      byBusiness: { label: string; cents: number }[];
      unmatched: { apiKey: string; cents: number }[];
      byModel: { model: string; cents: number }[];
    };

/**
 * Reads an Anthropic cost export and says what is in it.
 *
 * Admin keys are Team/Enterprise only, so on an individual account this CSV is
 * the only way to see what was actually billed. Read-only on purpose: it
 * summarises and splits by API key name — which is how each business is
 * identified — so the figure can be checked against the register. It writes
 * nothing until the usage ledger exists to write into, and says so rather than
 * pretending to have imported.
 *
 * Returns the numbers rather than a status string: `ActionForm` shows a fixed
 * success message and drops the payload, and a reader whose output you cannot
 * read is not a reader.
 */
export async function importAnthropicCostAction(
  _previous: AnthropicReadResult | null,
  formData: FormData,
): Promise<AnthropicReadResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };

  const pasted = String(formData.get("csv") ?? "");
  const file = formData.get("file");
  const text =
    pasted.trim().length > 0 ? pasted : file instanceof File && file.size > 0 ? await file.text() : "";
  if (text.trim().length === 0) return { status: "error", message: "Paste the CSV or choose the file" };

  const { summary } = parseAnthropicCostCsv(text);
  if (summary.rows === 0) {
    return { status: "error", message: "No priced rows found — is that the cost export from console.anthropic.com?" };
  }

  const { matched, unmatched } = centsByBusiness(summary);
  return {
    status: "ok",
    totalCents: summary.totalCents,
    rows: summary.rows,
    firstDay: summary.firstDay,
    lastDay: summary.lastDay,
    byBusiness: Object.entries(matched)
      .map(([business, cents]) => ({ label: BUSINESS_LABELS[business as CostBusiness], cents: cents ?? 0 }))
      .sort((a, b) => b.cents - a.cents),
    unmatched: Object.entries(unmatched)
      .map(([apiKey, cents]) => ({ apiKey, cents }))
      .sort((a, b) => b.cents - a.cents),
    byModel: Object.entries(summary.byModel)
      .map(([model, cents]) => ({ model, cents }))
      .sort((a, b) => b.cents - a.cents),
  };
}
