// Only leaf packages here: this module is imported from `instrumentation.ts`, which
// Next bundles for the edge runtime too, so the core barrel (and nodemailer behind
// it) must stay out of the graph.
import { isPublishedDefaultPassword } from "@launchos/db/passwords";
import {
  DEFAULT_VAT_RATE_PERCENT,
  describeAdapters,
  productionAdapterIssues,
  productionMockWarnings,
} from "@launchos/integrations";
import { z } from "zod";

/**
 * The web app's environment, validated once at module load.
 *
 * `apps/worker` has had `src/env.ts` since Plan 1; this is the same contract on
 * the web side, and CLAUDE.md rule 6 asks for it ("validate required env at
 * startup with Zod"). Only the variables read through this module are listed —
 * adding one here makes it fail loudly rather than silently defaulting.
 *
 * "Module load" is not the same as "server start": under `next start` a module
 * loads on the first request that reaches a route importing it, and the routes
 * importing this one are not the ones that send mail. `src/instrumentation.ts`
 * therefore imports this module from Next's `register()` hook, which runs once
 * before the server takes its first request — that is what makes the refusal
 * below a container that does not come up rather than a 500 on route five.
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

/**
 * The floor for `BETTER_AUTH_SECRET`, in characters.
 *
 * `openssl rand -base64 48` is 64 characters; 32 is the shortest value that
 * still carries enough entropy to be worth signing a session cookie with, and
 * is short enough that a hand-typed passphrase can clear it.
 */
export const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * The floor for `INBOUND_EMAIL_SECRET`, in characters.
 *
 * Lower than the session secret's because the two carry different weight: this
 * one is compared with `timingSafeEqual` on a single header
 * (`app/api/webhooks/email/inbound/route.ts`) and forging it manufactures
 * conversations and tickets, where forging a session cookie *is* the owner. 24
 * characters is `openssl rand -base64 18`, and every generator this repo
 * recommends clears it comfortably.
 */
export const MIN_INBOUND_SECRET_LENGTH = 24;

/** How to produce a real one, said the same way everywhere it is asked for. */
const GENERATE_SECRET = "generate one with `openssl rand -base64 48`";

/**
 * The base URL both hosts default to when `APP_URL` is unset.
 *
 * Fine locally and wrong in exactly one place: it is the host in the link a
 * client is asked to click in a courtesy email. `startupUrlIssues` refuses it
 * under `NODE_ENV=production` for that reason — see the same constant and the
 * same reasoning in `apps/worker/src/env.ts` and in `portalUrl()`
 * (`packages/agents/src/tools/messages-reply-to-client.ts`).
 */
export const LOCAL_APP_URL = "http://localhost:3000";

/**
 * Placeholder secrets this repository has published, checked by value.
 *
 * The same idea as `PUBLISHED_DEFAULT_PASSWORDS` in `packages/db/src/passwords.ts`,
 * for the same reason: a value printed in a public repository is not a secret,
 * and `cp .env.example .env` is exactly how one reaches a live deployment. The
 * published *passwords* are folded in through `isPublishedDefaultPassword` so
 * the two lists cannot drift — a placeholder added there is refused here too.
 *
 * `change-me` is under the length floor anyway, so this list only bites on a
 * padded placeholder. It exists because the next placeholder somebody invents
 * may not be short, and because the refusal it produces names the real problem
 * ("published in this repository") rather than a length.
 */
const PUBLISHED_DEFAULT_SECRETS: readonly string[] = [
  "change-me",
  "changeme",
  "change_me",
  "change-me-please",
  "please-change-me",
  "secret",
  "better-auth-secret",
  "dev-secret",
  "development",
];

/** Whether a value is one of the placeholders this repository ships. */
export function isPublishedDefaultSecret(value: string): boolean {
  const trimmed = value.trim();
  return PUBLISHED_DEFAULT_SECRETS.includes(trimmed.toLowerCase()) || isPublishedDefaultPassword(trimmed);
}

/** A Postgres connection string. Reused by the guard below rather than by a field. */
const DatabaseUrl = z.string().url();

export const Env = z.object({
  VAT_RATE: VatRatePercent.optional(),
  /**
   * Blank is unset — the same rule `withoutEmptyStrings` applies in
   * `apps/worker/src/env.ts` and the email factory. Without it a Coolify
   * variable created and left empty failed as a bare "Invalid URL" instead of
   * reaching `startupUrlIssues`, which is the check that says what the variable
   * is *for* and why production cannot do without it.
   */
  APP_URL: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().url().default(LOCAL_APP_URL),
  ),
  /**
   * Declared so this schema is the whole list of what the web process needs,
   * which is what `docs/DEPLOYMENT.md`'s web env list is written from. All
   * three are validated in `startupSecretIssues` rather than by a field, so the
   * refusal can name the fix ("generate one with …") and so the `next build`
   * exemption applies to them — a build has neither a database, a session to
   * sign, nor an inbound webhook to authenticate.
   */
  DATABASE_URL: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  INBOUND_EMAIL_SECRET: z.string().optional(),
  INBOUND_EMAIL_ENABLED: z.string().optional(),
  /**
   * Adapter selection, declared so this schema stays the whole list of what
   * the web process reads and so it matches `apps/worker/src/env.ts` key for
   * key — the adapter guard reads every one of these, and the worker's Zod
   * object would strip an undeclared one. The factories read them from
   * `process.env` themselves; `parseEnv` hands the raw source to the guard,
   * which treats a blank value as unset. `ADS_ADAPTER` is an intent, not a
   * selector: the ads factory selects by credential.
   */
  EMAIL_ADAPTER: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  PAYMENTS_ADAPTER: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  UPTIME_PROBE: z.string().optional(),
  ADS_ADAPTER: z.string().optional(),
  COOLIFY_API_URL: z.string().optional(),
  COOLIFY_API_TOKEN: z.string().optional(),
  COOLIFY_SERVER_UUID: z.string().optional(),
  COOLIFY_TIMEOUT_MS: z.string().optional(),
  HOSTINGER_API_TOKEN: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  SECRETS_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),
  GOOGLE_ADS_API_VERSION: z.string().optional(),
  META_ADS_ACCESS_TOKEN: z.string().optional(),
  META_ADS_APP_SECRET: z.string().optional(),
  GBP_CLIENT_ID: z.string().optional(),
  GBP_CLIENT_SECRET: z.string().optional(),
  GBP_REFRESH_TOKEN: z.string().optional(),
  META_ADS_API_VERSION: z.string().optional(),
  META_ADS_CONVERSION_ACTIONS: z.string().optional(),
  ALLOW_MOCK_ADAPTERS: z.string().optional(),
});
export type Env = z.infer<typeof Env>;

/**
 * The three secrets the process cannot run without, and the placeholder refusal.
 *
 * `docs/superpowers/specs/2026-09-03-agency-os-design.md:105` asks for exactly
 * this — "the process refuses to start without `DATABASE_URL` and
 * `BETTER_AUTH_SECRET`" — and until this existed neither was checked at boot.
 * `lib/auth.ts` tests `BETTER_AUTH_SECRET` for presence only, lazily, inside
 * `buildAuth()`: a container missing it started, passed `GET /api/health`, and
 * failed with a 500 on the first sign-in. A container carrying the published
 * `change-me` did not even fail — it signed every session cookie, `owner`
 * included, with a value anyone can read out of this repository.
 *
 * `INBOUND_EMAIL_SECRET` is here for the same reason and shipped the same
 * placeholder. The comparison itself is sound — `timingSafeEqual` in
 * `app/api/webhooks/email/inbound/route.ts` — but a deployment left on
 * `change-me` lets anyone `POST` that webhook and manufacture conversations and
 * tickets against any client, and `settings/email` reports only "Set" / "Not
 * set", so the placeholder reads as correctly configured. It is required rather
 * than optional deliberately: an unset secret is not "inbound is switched off",
 * it is a route whose only credential is a header nobody set.
 *
 * Exported so the rules can be tested without mutating `process.env`.
 */
export function startupSecretIssues(source: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];

  const databaseUrl = source.DATABASE_URL?.trim() ?? "";
  if (databaseUrl.length === 0) {
    issues.push("DATABASE_URL: not set — the web app, pg-boss and Better Auth all read it, e.g. postgres://user:pass@host:5432/launchos");
  } else if (!DatabaseUrl.safeParse(databaseUrl).success) {
    issues.push(`DATABASE_URL: not a connection URL (${databaseUrl.split("@").at(-1)}) — expected postgres://user:pass@host:5432/database`);
  }

  const secret = source.BETTER_AUTH_SECRET?.trim() ?? "";
  if (secret.length === 0) {
    issues.push(`BETTER_AUTH_SECRET: not set — every session cookie is signed with it, so ${GENERATE_SECRET}`);
  } else if (isPublishedDefaultSecret(secret)) {
    issues.push(
      `BETTER_AUTH_SECRET: a placeholder published in this repository — every session cookie, the owner's included, would be signed with a value anyone can read, so ${GENERATE_SECRET}`,
    );
  } else if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    issues.push(`BETTER_AUTH_SECRET: ${secret.length} characters; the minimum is ${MIN_AUTH_SECRET_LENGTH} — ${GENERATE_SECRET}`);
  }

  const inbound = source.INBOUND_EMAIL_SECRET?.trim() ?? "";
  if (inbound.length === 0) {
    issues.push(
      `INBOUND_EMAIL_SECRET: not set — it is the only credential on POST /api/webhooks/email/inbound, so ${GENERATE_SECRET}`,
    );
  } else if (isPublishedDefaultSecret(inbound)) {
    issues.push(
      `INBOUND_EMAIL_SECRET: a placeholder published in this repository — anyone could post to the inbound webhook and raise tickets against any client, so ${GENERATE_SECRET}`,
    );
  } else if (inbound.length < MIN_INBOUND_SECRET_LENGTH) {
    issues.push(`INBOUND_EMAIL_SECRET: ${inbound.length} characters; the minimum is ${MIN_INBOUND_SECRET_LENGTH} — ${GENERATE_SECRET}`);
  }

  return issues;
}

/**
 * `APP_URL` is a real address in production, not the local default.
 *
 * `Env` defaults it to `http://localhost:3000` so local work needs no
 * configuration, and that default is harmless for every internal link. It is
 * not harmless for the one string a client actually clicks: a portal reply
 * queues a courtesy email that says "sign in to the portal" and points at the
 * reader's own machine (review L1). Nothing downstream can tell a defaulted
 * value from a configured one, so the refusal has to happen here, and it has to
 * refuse the literal loopback default rather than only an absent variable —
 * `APP_URL=http://localhost:3000` on a Coolify resource does exactly the same
 * damage as leaving it out.
 *
 * Exported so the rule can be tested without mutating `process.env`.
 */
export function startupUrlIssues(source: NodeJS.ProcessEnv): string[] {
  if (source.NODE_ENV !== "production") return [];
  const appUrl = source.APP_URL?.trim() ?? "";
  if (appUrl.length === 0) {
    return [
      "APP_URL: not set — every portal link a client is emailed would point at http://localhost:3000. Set it to the address this app is served from, e.g. https://os.launchflow.co.uk",
    ];
  }
  if (!z.string().url().safeParse(appUrl).success) {
    return [`APP_URL: not a URL (${appUrl}) — expected the address this app is served from, e.g. https://os.launchflow.co.uk`];
  }
  if (appUrl.replace(/\/$/, "") === LOCAL_APP_URL) {
    return [
      `APP_URL: ${LOCAL_APP_URL} in production — a client emailed a portal link would be sent to their own machine. Set it to the address this app is served from.`,
    ];
  }
  return [];
}

/**
 * `next build` sets `NODE_ENV=production` and `NEXT_PHASE=phase-production-build`
 * and then imports every module that a page reaches, including this one. A build
 * neither sends mail nor probes a site, and `infra/Dockerfile.web` runs it long
 * before the runtime environment exists, so applying the adapter rule there
 * would refuse every production image at build time rather than at boot — which
 * is exactly the deployment this guard is meant to protect. The rule applies at
 * `next start`, where a real request could be served on a mock.
 *
 * It has to survive `instrumentation.ts`, even though Next never calls
 * `register()` under this phase: the build reaches *this module* directly, via
 * the five server-action modules that import it, not through the hook. Its cost
 * is the hole named in review M1 — a process started with
 * `NEXT_PHASE=phase-production-build` set by hand skips the refusal. The
 * mitigation is that `next start` never sets it and `infra/Dockerfile.web` does
 * not export it past the build layer.
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
  // The build exemption covers these too: `infra/Dockerfile.web` runs
  // `next build` long before a database or a session secret exists, and a build
  // signs nothing. `next start` is where a real cookie could be issued.
  const startupIssues = isBuild(source) ? [] : [...startupSecretIssues(source), ...startupUrlIssues(source)];
  if (startupIssues.length > 0) {
    throw new Error(`Invalid environment:\n- ${startupIssues.join("\n- ")}`);
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
  // And one warning per mock a production process is running on — the four
  // the guard tolerates unset, and the refused ones ALLOW_MOCK_ADAPTERS let
  // through. Same module, same words as the worker.
  for (const warning of productionMockWarnings(process.env)) console.warn(warning.message);
}

/** The VAT rate the organisation charges, as a whole-number percentage. */
export function vatRateFromEnv(): number {
  return env.VAT_RATE ?? DEFAULT_VAT_RATE_PERCENT;
}
