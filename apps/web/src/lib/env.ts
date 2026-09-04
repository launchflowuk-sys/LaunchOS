import { VAT_RATE_DEFAULT_PERCENT } from "@launchos/core";
import { z } from "zod";

/**
 * The web app's environment, validated once at module load.
 *
 * `apps/worker` has had `src/env.ts` since Plan 1; this is the same contract on
 * the web side, and CLAUDE.md rule 6 asks for it ("validate required env at
 * startup with Zod"). Only the variables read through this module are listed —
 * adding one here makes it fail loudly rather than silently defaulting.
 */

/**
 * A whole-number VAT percentage, e.g. `20`.
 *
 * Deliberately stricter than `Number(process.env.VAT_RATE)`: `Number("")` is
 * `0`, so a `VAT_RATE=` line left blank in a `.env` — or a Coolify variable
 * created and never filled in — used to mean every invoice went out at 0% VAT
 * with nothing to show for it. A blank or unparseable value is an error; only
 * an absent one falls back to the UK standard rate.
 */
const VatRatePercent = z
  .string()
  .transform((raw) => raw.trim())
  .refine((raw) => raw.length > 0, "VAT_RATE is set but empty — remove the line to use 20, or set a percentage")
  .transform(Number)
  .pipe(z.number().min(0).max(100));

export const Env = z.object({
  VAT_RATE: VatRatePercent.optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),
});
export type Env = z.infer<typeof Env>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);

/** The VAT rate the organisation charges, as a whole-number percentage. */
export function vatRateFromEnv(): number {
  return env.VAT_RATE ?? VAT_RATE_DEFAULT_PERCENT;
}
