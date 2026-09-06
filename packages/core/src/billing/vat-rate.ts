import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";

import { DEFAULT_VAT_RATE_PERCENT } from "@launchos/integrations";

/** UK standard rate, used whenever `VAT_RATE` is unset or unusable. The integrations
 * leaf owns the value so the web env schema and core cannot drift. */
export const VAT_RATE_DEFAULT_PERCENT: number = DEFAULT_VAT_RATE_PERCENT;

/**
 * Whether the supplier holds a VAT registration.
 *
 * The registration number on `organisations` is the whole test: a business
 * below the threshold has no number, and a whitespace-only column is not a
 * registration either.
 */
export function isVatRegistered(vatNumber: string | null | undefined): boolean {
  return typeof vatNumber === "string" && vatNumber.trim().length > 0;
}

/**
 * The configured standard rate. A blank or unparseable `VAT_RATE` falls back
 * to the UK standard rate rather than to 0% — `Number("")` is `0`, and a
 * variable someone created and never filled in must not silently zero-rate
 * every invoice.
 */
function standardRatePercent(env: NodeJS.ProcessEnv): number {
  const raw = env.VAT_RATE?.trim();
  if (!raw) return VAT_RATE_DEFAULT_PERCENT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : VAT_RATE_DEFAULT_PERCENT;
}

/**
 * The rate an invoice was actually raised at, read back off its own figures.
 *
 * A document must print the rate *that invoice* carries, not the rate the
 * organisation charges today: a re-rendered 2025 invoice cannot start claiming
 * 2026's rate, and `vatRateForOrganisation` is deliberately about now. The
 * only honest source is the pair of amounts on the row.
 *
 * Rounded to two decimals so 20% prints as `20` rather than `19.999…`, and
 * `0` when there is nothing to divide by — a zero-rated or zero-value invoice
 * has no rate to state.
 */
export function vatRatePercentCharged(subtotalPence: number, vatPence: number): number {
  if (subtotalPence <= 0 || vatPence <= 0) return 0;
  return Math.round((vatPence / subtotalPence) * 10_000) / 100;
}

/**
 * The VAT rate this organisation may raise an invoice at.
 *
 * Registration decides it, not configuration. A supplier with no VAT number on
 * `organisations` is not registered and can only charge 0%: charging VAT while
 * unregistered is money the client's accountant will reject, that the client
 * cannot reclaim, and that HMRC treats as an offence — every invoice raised in
 * that state has to be credited and reissued. `VAT_RATE` only chooses *which*
 * rate a registered supplier charges.
 *
 * This is the single authority on the question. Nothing that computes VAT —
 * core, a Server Action, an agent tool — may take a rate from anywhere else.
 */
export async function vatRateForOrganisation(
  db: Db,
  organisationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [organisation] = await db
    .select({ vatNumber: schema.organisations.vatNumber })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  if (!organisation) throw new Error(`organisation ${organisationId} not found`);
  return isVatRegistered(organisation.vatNumber) ? standardRatePercent(env) : 0;
}
