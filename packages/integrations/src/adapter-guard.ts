/**
 * Which adapter each factory will actually build, and the production rule that
 * refuses a mock.
 *
 * Selection itself is spread across four factories — `createEmailAdapter`
 * (`packages/channels`), `createPaymentsAdapter`, `createAdsAdapter` and the
 * `UPTIME_PROBE` branch in `createIntegrations`. This module is the one place
 * that *names* the outcome of all of them, for two jobs neither factory can do
 * on its own: printing the resolved set in the startup log, and refusing to boot
 * a production process on a mock.
 *
 * The reasoning is the one already written out for `LLM=fake` in
 * `apps/worker/src/env.ts`: an adapter that silently falls back to a mock does
 * not fail, it *succeeds wrongly*. `MockEmailAdapter` returns a provider message
 * id, so `sendQueuedMessage` marks the reply `sent`, stamps `deliveredAt` and
 * audits `message.sent`. A worker deployed without `EMAIL_ADAPTER=smtp`
 * black-holes every client reply, every ad report and every invoice email while
 * reporting all of them delivered, and nothing anywhere says otherwise.
 *
 * Kept in `packages/integrations` because it is a leaf both `apps/web` and
 * `apps/worker` already depend on, and because the payments rule (Stripe only
 * when both secrets are present) lives next door in `payments/index.ts`.
 */

/** The env fields adapter selection reads. Structural, so both `NodeJS.ProcessEnv` and a parsed env object fit. */
export interface AdapterEnv {
  readonly EMAIL_ADAPTER?: string | undefined;
  readonly PAYMENTS_ADAPTER?: string | undefined;
  readonly ADS_ADAPTER?: string | undefined;
  readonly UPTIME_PROBE?: string | undefined;
  readonly STRIPE_SECRET_KEY?: string | undefined;
  readonly STRIPE_WEBHOOK_SECRET?: string | undefined;
  readonly NODE_ENV?: string | undefined;
  readonly ALLOW_MOCK_ADAPTERS?: string | undefined;
}

export interface AdapterResolution {
  /** The name used in the startup log, e.g. `email`. */
  readonly name: string;
  /** The environment variable that selects it, or null when nothing selects it yet. */
  readonly variable: string | null;
  /** What the environment asked for. */
  readonly requested: string;
  /** What the factory will actually construct. */
  readonly resolved: string;
  /**
   * Whether a real implementation is reachable through this variable today.
   * `false` for the adapters that are mock-only by construction (ads, hosting,
   * DNS, CMS): refusing production on those would refuse production outright,
   * which would teach everyone to set `ALLOW_MOCK_ADAPTERS=1` and disarm the
   * whole guard. They are logged instead, so they stay visible.
   */
  readonly hasRealImplementation: boolean;
}

/** The one opt-out, spelled exactly. Anything else is not an opt-out. */
export const ALLOW_MOCK_ADAPTERS_VALUE = "1";

function isProduction(env: AdapterEnv): boolean {
  return env.NODE_ENV === "production";
}

/**
 * What each factory will build, given this environment.
 *
 * Mirrors the factories rather than calling them: resolving must not construct
 * an SMTP transport or a Stripe client, and `packages/integrations` does not
 * depend on `packages/channels`. Each branch below names the file it mirrors —
 * if one of them moves, this goes with it.
 */
export function resolveAdapters(env: AdapterEnv): AdapterResolution[] {
  // `packages/channels/src/email/factory.ts`: mock unless exactly "smtp".
  const email = env.EMAIL_ADAPTER === "smtp" ? "smtp" : "mock";
  // `payments/index.ts`: Stripe only when it is *fully* configured. A half-set
  // Stripe environment reads as `mock` here for the same reason it builds one.
  const payments =
    env.PAYMENTS_ADAPTER === "stripe" && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET ? "stripe" : "mock";
  // `createIntegrations`: http only when asked for.
  const uptime = env.UPTIME_PROBE === "http" ? "http" : "mock";
  return [
    { name: "email", variable: "EMAIL_ADAPTER", requested: env.EMAIL_ADAPTER ?? "mock", resolved: email, hasRealImplementation: true },
    { name: "payments", variable: "PAYMENTS_ADAPTER", requested: env.PAYMENTS_ADAPTER ?? "mock", resolved: payments, hasRealImplementation: true },
    { name: "uptime", variable: "UPTIME_PROBE", requested: env.UPTIME_PROBE ?? "mock", resolved: uptime, hasRealImplementation: true },
    // `ads/index.ts` always returns the mock; google/meta are interface-only.
    { name: "ads", variable: "ADS_ADAPTER", requested: env.ADS_ADAPTER ?? "mock", resolved: "mock", hasRealImplementation: false },
    { name: "hosting", variable: null, requested: "mock", resolved: "mock", hasRealImplementation: false },
    { name: "dns", variable: null, requested: "mock", resolved: "mock", hasRealImplementation: false },
    { name: "cms", variable: null, requested: "mock", resolved: "mock", hasRealImplementation: false },
  ];
}

/** `{ email: "mock", payments: "stripe", … }` — names only, for the startup log. */
export function describeAdapters(env: AdapterEnv): Record<string, string> {
  return Object.fromEntries(resolveAdapters(env).map((a) => [a.name, a.resolved]));
}

/**
 * Every reason this environment must not boot a production process, one message
 * per adapter. Empty outside production, and empty when `ALLOW_MOCK_ADAPTERS=1`
 * says the mocks were meant (a staging deployment, a dry run before the DNS
 * records verify).
 *
 * Two shapes are refused:
 *
 * 1. **A mock where a real adapter exists.** `EMAIL_ADAPTER=mock` in production
 *    reports every send as delivered; `UPTIME_PROBE=mock` reports every site up;
 *    `PAYMENTS_ADAPTER=mock` invoices against a fake ledger.
 * 2. **A silent downgrade.** The environment asked for something the factory
 *    cannot build and got the mock instead — `PAYMENTS_ADAPTER=stripe` with a
 *    key missing, `ADS_ADAPTER=google` with no client wired. This is the worse
 *    of the two, because the operator believes it is live, so it is refused for
 *    the mock-only adapters as well.
 */
export function productionAdapterIssues(env: AdapterEnv): { variable: string; message: string }[] {
  if (!isProduction(env)) return [];
  if (env.ALLOW_MOCK_ADAPTERS === ALLOW_MOCK_ADAPTERS_VALUE) return [];
  const issues: { variable: string; message: string }[] = [];
  for (const adapter of resolveAdapters(env)) {
    if (!adapter.variable) continue;
    if (adapter.resolved !== "mock") continue;
    const opt = `Set ALLOW_MOCK_ADAPTERS=1 to say you meant it.`;
    if (adapter.requested !== adapter.resolved) {
      issues.push({
        variable: adapter.variable,
        message:
          `${adapter.variable}=${adapter.requested} is not configured and falls back to the mock ${adapter.name} adapter, ` +
          `which is refused in production: the mock succeeds, so the failure is invisible. ${opt}`,
      });
      continue;
    }
    if (adapter.hasRealImplementation) {
      issues.push({
        variable: adapter.variable,
        message:
          `${adapter.variable}=mock is refused in production: the mock ${adapter.name} adapter reports success without ` +
          `doing anything, so nothing downstream ever shows a failure. ${opt}`,
      });
    }
  }
  return issues;
}

/**
 * Throws with every refusal at once, or returns the resolved names for the
 * startup log. Called from `apps/worker/src/env.ts` and `apps/web/src/lib/env.ts`
 * before either process opens a connection.
 */
export function assertProductionAdapters(env: AdapterEnv): Record<string, string> {
  const issues = productionAdapterIssues(env);
  if (issues.length > 0) {
    throw new Error(`Refusing to start in production on mock adapters:\n- ${issues.map((i) => i.message).join("\n- ")}`);
  }
  return describeAdapters(env);
}
