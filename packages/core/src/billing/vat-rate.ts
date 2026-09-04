import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";

/** UK standard rate, used whenever `VAT_RATE` is unset or unusable. */
export const VAT_RATE_DEFAULT_PERCENT = 20;

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
