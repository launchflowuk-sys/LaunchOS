/**
 * Which adapter each factory will actually build, and the production rule that
 * refuses a mock.
 *
 * Selection itself is spread across the factories — `createEmailAdapter`
 * (`packages/channels`), `createPaymentsAdapter`, `createAdsAdapterFromEnv`,
 * `createHostingProviderFromEnv`, `createDnsProvidersFromEnv`,
 * `createCmsProviderFromEnv`, `createSocialPublisherFromEnv`, `createPushAdapterFromEnv`
 * (`packages/channels`) and the
 * `UPTIME_PROBE` branch in `createIntegrations`. This module is the one place that *names* the outcome
 * of all of them, for two jobs no factory can do on its own: printing the
 * resolved set in the startup log, and refusing to boot a production process on
 * a mock it was not meant to run on.
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
 * `apps/worker` already depend on, and because most of the factories it mirrors
 * live next door.
 */
import { ADS_ENV_KEYS } from "./ads/index.js";
import { GBP_ENV_KEYS, META_SOCIAL_ENV_KEYS } from "./social/index.js";
import { ZOOM_ENV_KEYS } from "./meetings/index.js";

/**
 * The env fields adapter selection reads. Structural, so both
 * `NodeJS.ProcessEnv` and a parsed env object fit.
 *
 * **Every field here must survive the caller's own parsing.** `apps/worker`
 * hands `superRefine`'s value to `productionAdapterIssues`, and a Zod object
 * strips keys it does not declare — so a variable named here and *not* declared
 * in `apps/worker/src/env.ts` (and, for symmetry, `apps/web/src/lib/env.ts`)
 * arrives as `undefined` and reads as unset, which would refuse a perfectly
 * sound deployment. `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are
 * declared there for that reason alone; `SMTP_HOST` and `SMTP_PORT` joined them
 * when this module started reading them, and the hosting, DNS, CMS and ads
 * credentials below joined when their real adapters landed.
 *
 * Variables a factory reads but which do not change *which* adapter it builds
 * (`COOLIFY_SERVER_UUID`, `COOLIFY_TIMEOUT_MS`, `GOOGLE_ADS_API_VERSION`,
 * `META_ADS_API_VERSION`, `META_ADS_CONVERSION_ACTIONS`, `MOCK_ADS_DROP_FROM`)
 * are deliberately absent: the guard has nothing to say about them.
 */
export interface AdapterEnv {
  readonly EMAIL_ADAPTER?: string | undefined;
  readonly SMTP_HOST?: string | undefined;
  readonly SMTP_PORT?: string | undefined;
  readonly PAYMENTS_ADAPTER?: string | undefined;
  readonly STRIPE_SECRET_KEY?: string | undefined;
  readonly STRIPE_WEBHOOK_SECRET?: string | undefined;
  readonly UPTIME_PROBE?: string | undefined;
  readonly ADS_ADAPTER?: string | undefined;
  readonly GOOGLE_ADS_DEVELOPER_TOKEN?: string | undefined;
  readonly GOOGLE_ADS_CLIENT_ID?: string | undefined;
  readonly GOOGLE_ADS_CLIENT_SECRET?: string | undefined;
  readonly GOOGLE_ADS_REFRESH_TOKEN?: string | undefined;
  readonly GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string | undefined;
  readonly META_ADS_ACCESS_TOKEN?: string | undefined;
  readonly META_ADS_APP_SECRET?: string | undefined;
  readonly GBP_CLIENT_ID?: string | undefined;
  readonly GBP_CLIENT_SECRET?: string | undefined;
  readonly GBP_REFRESH_TOKEN?: string | undefined;
  readonly COOLIFY_API_URL?: string | undefined;
  readonly COOLIFY_API_TOKEN?: string | undefined;
  readonly HOSTINGER_API_TOKEN?: string | undefined;
  readonly CLOUDFLARE_API_TOKEN?: string | undefined;
  readonly SECRETS_ENCRYPTION_KEY?: string | undefined;
  readonly VAPID_PUBLIC_KEY?: string | undefined;
  readonly VAPID_PRIVATE_KEY?: string | undefined;
  readonly VAPID_SUBJECT?: string | undefined;
  readonly ZOOM_ACCOUNT_ID?: string | undefined;
  readonly ZOOM_CLIENT_ID?: string | undefined;
  readonly ZOOM_CLIENT_SECRET?: string | undefined;
  readonly NODE_ENV?: string | undefined;
  readonly ALLOW_MOCK_ADAPTERS?: string | undefined;
}

/**
 * The pair `createPushAdapterFromEnv` (`packages/channels/src/push/factory.ts`)
 * selects on. Repeated here rather than imported because `packages/channels`
 * is a leaf this package does not depend on — the same reason `resolveEmail`
 * mirrors the SMTP factory in prose. `adapter-guard.test.ts` loads the real
 * factory by path and fails if the two ever disagree.
 */
export const PUSH_ENV_KEYS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;

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
 * `createHostingProviderFromEnv` with a malformed `COOLIFY_API_URL` is the same
 * shape: it throws, by design, because a silent downgrade to the mock would
 * report every site healthy for ever.
 */
export const UNBUILDABLE = "unbuildable";

/**
 * What production does with this adapter when nothing selects it and the mock
 * is what gets built.
 *
 * - `refuse`: the mock is a boot refusal unless `ALLOW_MOCK_ADAPTERS=1`. Email,
 *   payments and uptime: every one of them has been selectable by a single
 *   variable since it shipped, and every production deployment has carried
 *   that variable, so an unset one is a variable lost in a redeploy.
 * - `log`: the mock is tolerated and **warned about** at startup, through
 *   `productionMockWarnings`. Hosting, DNS, CMS, ads and social: their real adapters
 *   landed after production was already running with none of their keys set,
 *   and a deployment whose domains are all `registrar` / `other`, or which has
 *   no ad accounts yet, is sound without them. Refusing would have refused the
 *   next deploy outright and taught everyone to set `ALLOW_MOCK_ADAPTERS=1`,
 *   which disarms the whole guard. What *is* refused for these four is the
 *   silent-downgrade case — a variable set but unusable, so the operator
 *   believes it is live — and the `UNBUILDABLE` case.
 */
export type MockWhenUnset = "refuse" | "log";

export interface AdapterResolution {
  /** The name used in the startup log, e.g. `email`. */
  readonly name: string;
  /**
   * The environment variable(s) that select it. Comma-separated when more than
   * one does (`dns`), and the intent variable for `ads`, whose selection is by
   * credential — see `resolveAds`.
   */
  readonly variable: string;
  /** What the environment asked for. */
  readonly requested: string;
  /** What the factory will actually construct, or `UNBUILDABLE` when it will throw. */
  readonly resolved: string;
  /** Why the factory would throw, in the words of the check that would reject it. Null when it builds. */
  readonly problem: string | null;
  /** Extra context for a refusal or a warning — which keys are missing, say. Null when there is none. */
  readonly note: string | null;
  /** Whether a real implementation is reachable through `variable` today. True for every adapter now. */
  readonly hasRealImplementation: boolean;
  /** See `MockWhenUnset`. */
  readonly mockWhenUnset: MockWhenUnset;
  /** What running on the mock actually does, for the refusal and the startup warning. */
  readonly mockEffect: string;
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
  return [
    {
      name: "email",
      variable: "EMAIL_ADAPTER",
      requested: env.EMAIL_ADAPTER ?? "mock",
      ...resolveEmail(env),
      hasRealImplementation: true,
      mockWhenUnset: "refuse",
      mockEffect: "every outbound email is recorded as delivered and sent nowhere",
    },
    {
      name: "payments",
      variable: "PAYMENTS_ADAPTER",
      requested: env.PAYMENTS_ADAPTER ?? "mock",
      ...resolvePayments(env),
      hasRealImplementation: true,
      mockWhenUnset: "refuse",
      mockEffect: "invoices are raised against a fake ledger",
    },
    {
      name: "uptime",
      variable: "UPTIME_PROBE",
      requested: env.UPTIME_PROBE ?? "mock",
      ...resolveUptime(env),
      hasRealImplementation: true,
      mockWhenUnset: "refuse",
      mockEffect: "every site reports up, so no incident is ever opened",
    },
    {
      name: "ads",
      variable: "ADS_ADAPTER",
      ...resolveAds(env),
      hasRealImplementation: true,
      mockWhenUnset: "log",
      mockEffect: "ad metrics are the deterministic mock series, not any client's real spend",
    },
    {
      name: "hosting",
      variable: "COOLIFY_API_URL",
      ...resolveHosting(env),
      hasRealImplementation: true,
      mockWhenUnset: "log",
      mockEffect: "hosting_get_resources answers healthy numbers for every ref, so the Hosting Guard-Dog diagnoses from fiction",
    },
    {
      name: "dns",
      variable: "HOSTINGER_API_TOKEN,CLOUDFLARE_API_TOKEN",
      ...resolveDns(env),
      hasRealImplementation: true,
      mockWhenUnset: "log",
      mockEffect: "approved DNS changes are recorded and audited but no zone is touched",
    },
    {
      name: "cms",
      variable: "SECRETS_ENCRYPTION_KEY",
      ...resolveCms(env),
      hasRealImplementation: true,
      mockWhenUnset: "log",
      mockEffect: "approved content changes are recorded and audited but no page is touched, and no site credential can be stored",
    },
    {
      name: "social",
      variable: [...META_SOCIAL_ENV_KEYS, ...GBP_ENV_KEYS].join(","),
      ...resolveSocial(env),
      hasRealImplementation: true,
      mockWhenUnset: "log",
      mockEffect: "approved Facebook, Instagram and Google Business Profile posts are marked published with a fake permalink and nothing reaches the page or profile",
    },
    {
      name: "push",
      variable: PUSH_ENV_KEYS.join(","),
      ...resolvePush(env),
      hasRealImplementation: true,
      mockWhenUnset: "log",
      mockEffect: "urgent alerts (incidents, failed payments, SLA breaches, a worker outage) never reach a phone; the bell in the portal still rings",
    },
    {
      name: "meetings",
      variable: ZOOM_ENV_KEYS.join(","),
      ...resolveMeetings(env),
      hasRealImplementation: true,
      mockWhenUnset: "log",
      mockEffect: "booked calls get a join link on meet.launchflow.example that opens nothing; no Zoom meeting is created",
    },
  ];
}

/** What one factory does with this environment: the adapter it returns, or why it throws. */
type FactoryOutcome = Pick<AdapterResolution, "resolved" | "problem" | "note">;
/** The same, for the adapters whose `requested` is derived from more than one variable. */
type SelectionOutcome = FactoryOutcome & Pick<AdapterResolution, "requested">;

function builds(resolved: string, note: string | null = null): FactoryOutcome {
  return { resolved, problem: null, note };
}

function unbuildable(problem: string): FactoryOutcome {
  return { resolved: UNBUILDABLE, problem, note: null };
}

/**
 * `packages/channels/src/email/factory.ts`, line by line.
 *
 * ```ts
 * const source = withoutEmptyStrings(env);  // `SMTP_PORT=` means unset
 * if (source.EMAIL_ADAPTER !== "smtp") return new MockEmailAdapter();
 * const cfg = SmtpEnv.parse(source);        // throws — it does not fall back
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
  if (blankAsUnset(env.EMAIL_ADAPTER) !== "smtp") return builds("mock");
  // `z.string().min(1)`: unset and empty both reject. A blank-but-not-empty
  // host (" ") passes there, so it passes here too — same adapter, same bug.
  const host = blankAsUnset(env.SMTP_HOST);
  if (host === undefined) {
    return unbuildable("SMTP_HOST is required when EMAIL_ADAPTER=smtp and is not set");
  }
  // `.default(587)` applies only to `undefined`, and the factory normalises
  // `SMTP_PORT=` to unset before Zod sees it, so a variable created and left
  // blank on a Coolify resource means "the default, 587" in both places. A
  // value that is present and not a port is still named.
  const port = blankAsUnset(env.SMTP_PORT);
  if (port !== undefined && !coercesToPort(port)) {
    return unbuildable(`SMTP_PORT=${port} is not a positive whole number (leave it unset for the default, 587)`);
  }
  return builds("smtp");
}

/**
 * A blank environment variable is an unset one — the factory's own rule.
 *
 * `withoutEmptyStrings` in `packages/channels/src/email/factory.ts` and in
 * `apps/worker/src/env.ts` strip exactly `""` and nothing else; this mirrors
 * them per field, because this module reads a structural `AdapterEnv` rather
 * than a whole `process.env`. Until all three agreed, the worker parsed its env
 * with the blanks stripped, resolved adapters on the stripped copy, and then
 * handed the *raw* `process.env` to the factory — so the guard printed a
 * healthy environment five lines before the factory threw on it.
 */
function blankAsUnset(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

/**
 * The stricter rule the newer factories apply: `value?.trim()` must be
 * non-empty. `createHostingProviderFromEnv`, `createDnsProvidersFromEnv`,
 * `createCmsProviderFromEnv` and the ads credential check all read a
 * whitespace-only variable as unset, so the guard must too.
 */
function trimmedOrUnset(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

/**
 * `ads/index.ts` `createAdsAdapterFromEnv`: selection is **by credential**, not
 * by name. Google is real when all five `GOOGLE_ADS_*` keys are set, Meta when
 * both `META_ADS_*` keys are; both together build the multi-platform router
 * (`name: "multi"`, reported here as `google+meta`); neither builds the mock.
 * A half-set platform is treated as unset and falls back — the same downgrade
 * `createPaymentsAdapter` performs, and the reason this branch exists.
 *
 * `requested` is therefore the *intent*: every platform with at least one of
 * its keys set, plus whatever `ADS_ADAPTER` names. `ADS_ADAPTER` no longer
 * selects anything — the factory does not read it — but it is kept as the way
 * to say "I mean Google", so that a deployment which lost its credentials in a
 * redeploy is refused rather than quietly reverting to the mock series.
 * `ADS_ADAPTER=mock` says nothing either way.
 */
function resolveAds(env: AdapterEnv): SelectionOutcome {
  const platforms = [
    { name: "google", keys: ADS_ENV_KEYS.google },
    { name: "meta", keys: ADS_ENV_KEYS.meta },
  ] as const;
  const intent = trimmedOrUnset(env.ADS_ADAPTER);
  const requested: string[] = [];
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const platform of platforms) {
    const set = platform.keys.filter((key) => trimmedOrUnset(env[key]) !== undefined);
    const complete = set.length === platform.keys.length;
    if (set.length > 0 || intent === platform.name) requested.push(platform.name);
    if (complete) resolved.push(platform.name);
    else if (set.length > 0 || intent === platform.name) {
      missing.push(...platform.keys.filter((key) => !set.includes(key)));
    }
  }
  return {
    requested: requested.length > 0 ? requested.join("+") : "mock",
    ...builds(resolved.length > 0 ? resolved.join("+") : "mock", missing.length > 0 ? `Missing: ${missing.join(", ")}.` : null),
  };
}

/**
 * `coolify/index.ts` `createHostingProviderFromEnv`: the real client when both
 * `COOLIFY_API_URL` and `COOLIFY_API_TOKEN` are non-blank after trimming, the
 * mock otherwise. Only when both are present does the constructor parse the
 * URL (`normaliseBaseUrl` in `coolify.ts`), and it **throws** on one that
 * `new URL` rejects or that is not http(s) — so that is `UNBUILDABLE`, not a
 * downgrade. A URL alone or a token alone is the downgrade case: the factory
 * builds the mock, and `requested` says `coolify` so production refuses it.
 */
function resolveHosting(env: AdapterEnv): SelectionOutcome {
  const url = trimmedOrUnset(env.COOLIFY_API_URL);
  const token = trimmedOrUnset(env.COOLIFY_API_TOKEN);
  if (url === undefined && token === undefined) return { requested: "mock", ...builds("mock") };
  if (url === undefined) {
    return { requested: "coolify", ...builds("mock", "COOLIFY_API_TOKEN is set but COOLIFY_API_URL is not.") };
  }
  if (token === undefined) {
    return { requested: "coolify", ...builds("mock", "COOLIFY_API_URL is set but COOLIFY_API_TOKEN is not.") };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { requested: "coolify", ...unbuildable(`COOLIFY_API_URL is not a valid URL: "${url}"`) };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { requested: "coolify", ...unbuildable(`COOLIFY_API_URL must be http or https, got "${parsed.protocol}"`) };
  }
  return { requested: "coolify", ...builds("coolify") };
}

/**
 * `dns/registry.ts` `createDnsProvidersFromEnv`: one provider per value of
 * `domains.dns_provider`, each real when its token is set and a mock when it is
 * not, so the resolution is the set of live halves — `hostinger+cloudflare`,
 * `hostinger`, `cloudflare` or `mock`. There is no downgrade and no unbuildable
 * state: a token is passed straight to a constructor that does not validate it,
 * and a domain whose provider has no token goes to a mock the approval card
 * names. A blank token is unset, as in the factory.
 */
function resolveDns(env: AdapterEnv): SelectionOutcome {
  const live = [
    trimmedOrUnset(env.HOSTINGER_API_TOKEN) !== undefined ? "hostinger" : null,
    trimmedOrUnset(env.CLOUDFLARE_API_TOKEN) !== undefined ? "cloudflare" : null,
  ].filter((name): name is string => name !== null);
  const resolved = live.length > 0 ? live.join("+") : "mock";
  return { requested: resolved, ...builds(resolved) };
}

/**
 * `cms/index.ts` `createCmsProviderFromEnv`: `SECRETS_ENCRYPTION_KEY?.trim()`
 * truthy builds the WordPress provider, anything else the mock. It never
 * throws — a key of the wrong shape is refused by `packages/core`'s
 * `SecretsKeyError` at the first credential read or write, which is loud and
 * names the problem, so there is no `UNBUILDABLE` branch to mirror.
 */
function resolveCms(env: AdapterEnv): SelectionOutcome {
  const resolved = trimmedOrUnset(env.SECRETS_ENCRYPTION_KEY) !== undefined ? "wordpress" : "mock";
  return { requested: resolved, ...builds(resolved) };
}

/**
 * `social/index.ts` `createSocialPublisherFromEnv`: selection is **by
 * credential, per provider**, the way `resolveAds` is. Meta is real when both
 * `META_ADS_*` keys are non-blank — the same pair and the same trim rule as the
 * Meta half of `resolveAds`, because it is the same system-user token doing a
 * second job — and Google Business Profile when all three `GBP_*` keys are.
 * Both build the composite (`meta+gbp`); one builds a composite whose other
 * half is a mock (`meta` or `gbp`); neither builds the plain mock.
 *
 * A provider with some but not all of its keys set is a downgrade the guard
 * refuses, exactly as `resolveAds` does for a half-set platform, so a token
 * lost in a redeploy cannot leave the content engine quietly "publishing" to
 * a mock. Neither constructor validates beyond presence, so there is no
 * `UNBUILDABLE` branch.
 */
function resolveSocial(env: AdapterEnv): SelectionOutcome {
  const providers = [
    { name: "meta", keys: META_SOCIAL_ENV_KEYS },
    { name: "gbp", keys: GBP_ENV_KEYS },
  ] as const;
  const requested: string[] = [];
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const provider of providers) {
    const set = provider.keys.filter((key) => trimmedOrUnset(env[key]) !== undefined);
    if (set.length === 0) continue;
    requested.push(provider.name);
    if (set.length === provider.keys.length) resolved.push(provider.name);
    else missing.push(...provider.keys.filter((key) => !set.includes(key)));
  }
  return {
    requested: requested.length > 0 ? requested.join("+") : "mock",
    ...builds(resolved.length > 0 ? resolved.join("+") : "mock", missing.length > 0 ? `Missing: ${missing.join(", ")}.` : null),
  };
}

/** Web push's VAPID subject: `mailto:` or `https:`, the same test `isValidVapidSubject` applies in the factory. */
const VAPID_SUBJECT_PATTERN = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/;

/**
 * `packages/channels/src/push/factory.ts` `createPushAdapterFromEnv`: web
 * push when both VAPID keys are non-blank after trimming, the mock otherwise.
 * One key without the other is the downgrade case — `requested` says
 * `web-push` so production refuses it — and both keys with `VAPID_SUBJECT`
 * missing or malformed is `UNBUILDABLE`, because the factory throws rather
 * than pushing unsigned. Unset entirely is tolerated with a warning: the
 * bell still rings in the portal; only the phone stays quiet.
 */
function resolvePush(env: AdapterEnv): SelectionOutcome {
  const set = PUSH_ENV_KEYS.filter((key) => trimmedOrUnset(env[key]) !== undefined);
  if (set.length === 0) return { requested: "mock", ...builds("mock") };
  if (set.length < PUSH_ENV_KEYS.length) {
    const missing = PUSH_ENV_KEYS.filter((key) => !set.includes(key));
    return { requested: "web-push", ...builds("mock", `Missing: ${missing.join(", ")}.`) };
  }
  const subject = trimmedOrUnset(env.VAPID_SUBJECT);
  if (subject === undefined) {
    return { requested: "web-push", ...unbuildable("VAPID_SUBJECT is required when VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set (a mailto: address)") };
  }
  if (!VAPID_SUBJECT_PATTERN.test(subject)) {
    return { requested: "web-push", ...unbuildable(`VAPID_SUBJECT must be a mailto: address or an https: URL, got ${JSON.stringify(subject)}`) };
  }
  return { requested: "web-push", ...builds("web-push") };
}

/**
 * `meetings/index.ts` `createMeetingsAdapterFromEnv`: Zoom when all three
 * `ZOOM_*` keys are non-blank after trimming, the mock otherwise. One or two
 * of the three is the downgrade case — `requested` says `zoom` so production
 * refuses it. The constructor validates presence only, so there is no
 * `UNBUILDABLE` branch; a wrong secret fails at the first booking.
 */
function resolveMeetings(env: AdapterEnv): SelectionOutcome {
  const set = ZOOM_ENV_KEYS.filter((key) => trimmedOrUnset(env[key]) !== undefined);
  if (set.length === 0) return { requested: "mock", ...builds("mock") };
  if (set.length < ZOOM_ENV_KEYS.length) {
    const missing = ZOOM_ENV_KEYS.filter((key) => !set.includes(key));
    return { requested: "zoom", ...builds("mock", `Missing: ${missing.join(", ")}.`) };
  }
  return { requested: "zoom", ...builds("zoom") };
}

/** `{ email: "mock", payments: "stripe", … }` — names only, for the startup log. */
export function describeAdapters(env: AdapterEnv): Record<string, string> {
  return Object.fromEntries(resolveAdapters(env).map((a) => [a.name, a.resolved]));
}

export interface AdapterIssue {
  readonly variable: string;
  readonly message: string;
}

/**
 * Every reason this environment must not boot a production process, one message
 * per adapter. Empty outside production, and empty when `ALLOW_MOCK_ADAPTERS=1`
 * says the mocks were meant (a staging deployment, a dry run before the DNS
 * records verify).
 *
 * Three shapes are refused:
 *
 * 1. **A mock where the rule is `refuse`** (`MockWhenUnset`). `EMAIL_ADAPTER=mock`
 *    in production reports every send as delivered; `UPTIME_PROBE=mock` reports
 *    every site up; `PAYMENTS_ADAPTER=mock` invoices against a fake ledger. The
 *    four `log` adapters are *not* refused for being unset — see `MockWhenUnset`
 *    for why — they are warned about through `productionMockWarnings`.
 * 2. **A silent downgrade**, for every adapter. The environment asked for
 *    something the factory cannot build and got less — `PAYMENTS_ADAPTER=stripe`
 *    with a key missing, `COOLIFY_API_TOKEN` without `COOLIFY_API_URL`, three of
 *    the five `GOOGLE_ADS_*` keys. This is the worse of the two, because the
 *    operator believes it is live, so it is refused for the `log` adapters too.
 * 3. **A real adapter that cannot be constructed** (`UNBUILDABLE`):
 *    `EMAIL_ADAPTER=smtp` with no `SMTP_HOST`, a `COOLIFY_API_URL` that is not
 *    a URL. The factory throws, so nothing is downgraded and nothing is
 *    black-holed — but the process is broken, and the web app fails one send at
 *    a time rather than at boot.
 *
 * `ALLOW_MOCK_ADAPTERS=1` suppresses the first two and **not** the third: it
 * says "I meant the mocks", which is not something anyone can mean about a
 * configuration that throws. Refusing at boot is strictly better than the same
 * exception arriving from the first invoice send.
 */
export function productionAdapterIssues(env: AdapterEnv): AdapterIssue[] {
  if (!isProduction(env)) return [];
  const mocksAllowed = env.ALLOW_MOCK_ADAPTERS === ALLOW_MOCK_ADAPTERS_VALUE;
  const issues: AdapterIssue[] = [];
  for (const adapter of resolveAdapters(env)) {
    if (adapter.resolved === UNBUILDABLE) {
      issues.push({
        variable: adapter.variable,
        message:
          `${adapter.variable}=${adapter.requested} is selected but the ${adapter.name} adapter cannot be built: ` +
          `${adapter.problem ?? "the factory rejects this environment"}. The factory throws rather than falling back, ` +
          `so the worker dies at boot and the web app returns a 500 from every use. ALLOW_MOCK_ADAPTERS does not ` +
          `cover this — fix the configuration, or unset ${adapter.variable} if the mock is what you meant.`,
      });
      continue;
    }
    if (mocksAllowed) continue;
    const opt = `Set ALLOW_MOCK_ADAPTERS=1 to say you meant it.`;
    const note = adapter.note ? ` ${adapter.note}` : "";
    if (adapter.requested !== adapter.resolved) {
      issues.push({
        variable: adapter.variable,
        message:
          adapter.resolved === "mock"
            ? `${adapter.variable}=${adapter.requested} is not configured and falls back to the mock ${adapter.name} adapter, ` +
              `which is refused in production: the mock succeeds, so the failure is invisible.${note} ${opt}`
            : `The ${adapter.name} adapter is partly configured: ${adapter.requested} was asked for but only ${adapter.resolved} ` +
              `can be built, and the rest falls back to the mock, which is refused in production.${note} ${opt}`,
      });
      continue;
    }
    if (adapter.resolved !== "mock") continue;
    if (adapter.hasRealImplementation && adapter.mockWhenUnset === "refuse") {
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
 * Every adapter a production process is about to run on a mock, whether or not
 * it was refused — one line each, for the startup log. Empty outside production.
 *
 * This is the other half of `MockWhenUnset`: the `log` adapters are tolerated
 * unset because refusing them would have refused a running deployment, but a
 * log line that says *what the mock does* is the least they owe the operator.
 * The `refuse` adapters appear here too when `ALLOW_MOCK_ADAPTERS=1` let them
 * through, for the same reason — the opt-out is all-or-nothing, and nothing
 * else reminds anyone it is set.
 */
export function productionMockWarnings(env: AdapterEnv): AdapterIssue[] {
  if (!isProduction(env)) return [];
  return resolveAdapters(env)
    .filter((adapter) => adapter.resolved === "mock")
    .map((adapter) => ({
      variable: adapter.variable,
      message:
        `${adapter.name} adapter is the MOCK (${adapter.variable} unset): ${adapter.mockEffect}. ` +
        `Set ${adapter.variable} to go live.`,
    }));
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
