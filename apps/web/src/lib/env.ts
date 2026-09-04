import { VAT_RATE_DEFAULT_PERCENT } from "@launchos/core";
import { isPublishedDefaultPassword } from "@launchos/db/passwords";
import { describeAdapters, productionAdapterIssues } from "@launchos/integrations";
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

/** How to produce a real one, said the same way everywhere it is asked for. */
const GENERATE_SECRET = "generate one with `openssl rand -base64 48`";

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
  APP_URL: z.string().url().default("http://localhost:3000"),
  /**
   * Declared so this schema is the whole list of what the web process needs,
   * which is what `docs/DEPLOYMENT.md`'s web env list is written from. Both are
   * validated in `startupSecretIssues` rather than by a field, so the refusal
   * can name the fix ("generate one with …") and so the `next build` exemption
   * applies to them — a build has neither a database nor a session to sign.
   */
  DATABASE_URL: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
});
export type Env = z.infer<typeof Env>;

/**
 * The two secrets the process cannot run without, and the placeholder refusal.
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

  return issues;
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
  const secretIssues = isBuild(source) ? [] : startupSecretIssues(source);
  if (secretIssues.length > 0) {
    throw new Error(`Invalid environment:\n- ${secretIssues.join("\n- ")}`);
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
