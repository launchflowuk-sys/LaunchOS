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

/**
 * The env fields adapter selection reads. Structural, so both
 * `NodeJS.ProcessEnv` and a parsed env object fit.
 *
 * **Every field here must survive the caller's own parsing.** `apps/worker`
 * hands `superRefine`'s value to `productionAdapterIssues`, and a Zod object
 * strips keys it does not declare — so a variable named here and *not* declared
 * in `apps/worker/src/env.ts` arrives as `undefined` and reads as unset, which
 * would refuse a perfectly sound deployment. `STRIPE_SECRET_KEY` and
 * `STRIPE_WEBHOOK_SECRET` are declared there for that reason alone; `SMTP_HOST`
 * and `SMTP_PORT` joined them when this module started reading them.
 */
export interface AdapterEnv {
  readonly EMAIL_ADAPTER?: string | undefined;
  readonly SMTP_HOST?: string | undefined;
  readonly SMTP_PORT?: string | undefined;
  readonly PAYMENTS_ADAPTER?: string | undefined;
  readonly ADS_ADAPTER?: string | undefined;
  readonly UPTIME_PROBE?: string | undefined;
  readonly STRIPE_SECRET_KEY?: string | undefined;
  readonly STRIPE_WEBHOOK_SECRET?: string | undefined;
  readonly NODE_ENV?: string | undefined;
  readonly ALLOW_MOCK_ADAPTERS?: string | undefined;
}

/**
 * The third resolution: the environment selected a real adapter the factory
 * cannot construct, and the factory *throws* rather than downgrading.
 *
 * It is deliberately not folded into `"mock"`. `createEmailAdapter` with
 * `EMAIL_ADAPTER=smtp` and no `SMTP_HOST` does not black-hole mail the way the
 * mock does — it takes the worker down at boot (loud, survivable) and returns a
 * 500 from every invoice send and "test email" in the web app, which builds its
 * adapters inside server actions. Reporting that as `mock` would be a second
 * lie on top of the first, and reporting it as `smtp` — which this guard used to
 * do — tells the operator the environment is sound when the next send will fail.
 */
export const UNBUILDABLE = "unbuildable";

export interface AdapterResolution {
  /** The name used in the startup log, e.g. `email`. */
  readonly name: string;
  /** The environment variable that selects it, or null when nothing selects it yet. */
  readonly variable: string | null;
  /** What the environment asked for. */
  readonly requested: string;
  /** What the factory will actually construct, or `UNBUILDABLE` when it will throw. */
  readonly resolved: string;
  /** Why the factory would throw, in the words of the check that would reject it. Null when it builds. */
  readonly problem: string | null;
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
  const email = resolveEmail(env);
  const payments = resolvePayments(env);
  const uptime = resolveUptime(env);
  return [
    { name: "email", variable: "EMAIL_ADAPTER", requested: env.EMAIL_ADAPTER ?? "mock", ...email, hasRealImplementation: true },
    { name: "payments", variable: "PAYMENTS_ADAPTER", requested: env.PAYMENTS_ADAPTER ?? "mock", ...payments, hasRealImplementation: true },
    { name: "uptime", variable: "UPTIME_PROBE", requested: env.UPTIME_PROBE ?? "mock", ...uptime, hasRealImplementation: true },
    // `ads/index.ts` always returns `new MockAdsAdapter(...)`; google/meta are
    // interface-only, and `MOCK_ADS_DROP_FROM` is passed straight through
    // without validation, so no environment can make this one throw.
    { name: "ads", variable: "ADS_ADAPTER", requested: env.ADS_ADAPTER ?? "mock", ...builds("mock"), hasRealImplementation: false },
    { name: "hosting", variable: null, requested: "mock", ...builds("mock"), hasRealImplementation: false },
    { name: "dns", variable: null, requested: "mock", ...builds("mock"), hasRealImplementation: false },
    { name: "cms", variable: null, requested: "mock", ...builds("mock"), hasRealImplementation: false },
  ];
}

/** What one factory does with this environment: the adapter it returns, or why it throws. */
type FactoryOutcome = Pick<AdapterResolution, "resolved" | "problem">;

function builds(resolved: string): FactoryOutcome {
  return { resolved, problem: null };
}

/**
 * `packages/channels/src/email/factory.ts`, line by line.
 *
 * ```ts
 * if (env.EMAIL_ADAPTER !== "smtp") return new MockEmailAdapter();
 * const cfg = SmtpEnv.parse(env);          // throws — it does not fall back
 * ```
 *
 * `SmtpEnv` is `SMTP_HOST: z.string().min(1)` and
 * `SMTP_PORT: z.coerce.number().int().positive().default(587)`; `SMTP_USER` and
 * `SMTP_PASS` are optional strings, which an environment variable always
 * satisfies. So exactly two fields can reject, and both are mirrored below.
 * `MAIL_FROM` is deliberately absent: the factory never reads it, and every
 * send site falls back to `supportEmailFor(...)` when it is unset, so it cannot
 * change which adapter is built.
 */
function resolveEmail(env: AdapterEnv): FactoryOutcome {
  if (env.EMAIL_ADAPTER !== "smtp") return builds("mock");
  // `z.string().min(1)`: unset and empty both reject. A blank-but-not-empty
  // host (" ") passes there, so it passes here too — same adapter, same bug.
  if (env.SMTP_HOST === undefined || env.SMTP_HOST.length === 0) {
    return { resolved: UNBUILDABLE, problem: "SMTP_HOST is required when EMAIL_ADAPTER=smtp and is not set" };
  }
  // `.default(587)` applies only to `undefined`, so `SMTP_PORT=` (the shape
  // `.env.example` ships) is coerced — `Number("")` is 0 — and rejected.
  if (env.SMTP_PORT !== undefined && !coercesToPort(env.SMTP_PORT)) {
    return {
      resolved: UNBUILDABLE,
      problem: `SMTP_PORT=${env.SMTP_PORT} is not a positive whole number (leave it unset for the default, 587)`,
    };
  }
  return builds("smtp");
}

/** `z.coerce.number().int().positive()` — `Number(raw)`, then a positive safe integer. */
function coercesToPort(raw: string): boolean {
  const port = Number(raw);
  return Number.isSafeInteger(port) && port > 0;
}

/**
 * `payments/index.ts`: Stripe only when it is *fully* configured. A half-set
 * Stripe environment reads as `mock` here for the same reason it builds one —
 * that factory downgrades rather than throwing, deliberately, so a missing key
 * cannot take the whole app down. `new Stripe(secretKey)` accepts any non-empty
 * string, and the truthiness check above already excludes the empty one, so
 * there is no unbuildable state on this branch.
 */
function resolvePayments(env: AdapterEnv): FactoryOutcome {
  const stripe = env.PAYMENTS_ADAPTER === "stripe" && Boolean(env.STRIPE_SECRET_KEY) && Boolean(env.STRIPE_WEBHOOK_SECRET);
  return builds(stripe ? "stripe" : "mock");
}

/**
 * `createIntegrations`: `UPTIME_PROBE === "http"` picks `new HttpUptimeProbe()`,
 * anything else `new MockUptimeProbe(parseDownUrls(env.MOCK_DOWN_URLS))`. Both
 * constructors take what they are given without validating it, so neither
 * throws whatever `MOCK_DOWN_URLS` holds.
 */
function resolveUptime(env: AdapterEnv): FactoryOutcome {
  return builds(env.UPTIME_PROBE === "http" ? "http" : "mock");
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
 * Three shapes are refused:
 *
 * 1. **A mock where a real adapter exists.** `EMAIL_ADAPTER=mock` in production
 *    reports every send as delivered; `UPTIME_PROBE=mock` reports every site up;
 *    `PAYMENTS_ADAPTER=mock` invoices against a fake ledger.
 * 2. **A silent downgrade.** The environment asked for something the factory
 *    cannot build and got the mock instead — `PAYMENTS_ADAPTER=stripe` with a
 *    key missing, `ADS_ADAPTER=google` with no client wired. This is the worse
 *    of the two, because the operator believes it is live, so it is refused for
 *    the mock-only adapters as well.
 * 3. **A real adapter that cannot be constructed** (`UNBUILDABLE`):
 *    `EMAIL_ADAPTER=smtp` with no `SMTP_HOST`. The factory throws, so nothing is
 *    downgraded and nothing is black-holed — but the process is broken, and the
 *    web app fails one send at a time rather than at boot.
 *
 * `ALLOW_MOCK_ADAPTERS=1` suppresses the first two and **not** the third: it
 * says "I meant the mocks", which is not something anyone can mean about a
 * configuration that throws. Refusing at boot is strictly better than the same
 * exception arriving from the first invoice send.
 */
export function productionAdapterIssues(env: AdapterEnv): { variable: string; message: string }[] {
  if (!isProduction(env)) return [];
  const mocksAllowed = env.ALLOW_MOCK_ADAPTERS === ALLOW_MOCK_ADAPTERS_VALUE;
  const issues: { variable: string; message: string }[] = [];
  for (const adapter of resolveAdapters(env)) {
    if (!adapter.variable) continue;
    if (adapter.resolved === UNBUILDABLE) {
      issues.push({
        variable: adapter.variable,
        message:
          `${adapter.variable}=${adapter.requested} is selected but the ${adapter.name} adapter cannot be built: ` +
          `${adapter.problem ?? "the factory rejects this environment"}. The factory throws rather than falling back, ` +
          `so the worker dies at boot and the web app returns a 500 from every send. ALLOW_MOCK_ADAPTERS does not ` +
          `cover this — fix the configuration, or set ${adapter.variable}=mock if the mock is what you meant.`,
      });
      continue;
    }
    if (mocksAllowed) continue;
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
