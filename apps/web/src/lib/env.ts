import { VAT_RATE_DEFAULT_PERCENT } from "@launchos/core";
import { describeAdapters, productionAdapterIssues } from "@launchos/integrations";
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

/**
 * `next build` sets `NODE_ENV=production` and `NEXT_PHASE=phase-production-build`
 * and then imports every module that a page reaches, including this one. A build
 * neither sends mail nor probes a site, and `infra/Dockerfile.web` runs it long
 * before the runtime environment exists, so applying the adapter rule there
 * would refuse every production image at build time rather than at boot — which
 * is exactly the deployment this guard is meant to protect. The rule applies at
 * `next start`, where a real request could be served on a mock.
 */
function isBuild(source: NodeJS.ProcessEnv): boolean {
  return source.NEXT_PHASE === "phase-production-build";
}

/**
 * The same production adapter rule the worker applies, from the same module.
 *
 * The web process resolves adapters too — `createIntegrations` for the billing
 * screens and the Stripe webhook, `createEmailAdapter` wherever a server action
 * sends directly — and a mock there fails exactly as quietly as it does in the
 * worker: it succeeds. One process refusing to boot on mocks while the other
 * happily runs on them would be worse than neither, because the deployment would
 * look healthy from the outside.
 *
 * Exported so the rules can be tested without mutating `process.env`.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  const adapterIssues = isBuild(source) ? [] : productionAdapterIssues(source);
  if (adapterIssues.length > 0) {
    throw new Error(`Refusing to start in production on mock adapters:\n- ${adapterIssues.map((i) => i.message).join("\n- ")}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);

// Which adapters this process resolved, once per server start. Names only — no
// hosts, keys or addresses. Suppressed under `NODE_ENV=test` so a unit run does
// not print a line per worker thread.
if (process.env.NODE_ENV !== "test" && process.env.NEXT_PHASE !== "phase-production-build") {
  console.info({ adapters: describeAdapters(process.env) }, "web adapters");
}

/** The VAT rate the organisation charges, as a whole-number percentage. */
export function vatRateFromEnv(): number {
  return env.VAT_RATE ?? VAT_RATE_DEFAULT_PERCENT;
}
