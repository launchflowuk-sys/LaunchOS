import { z } from "zod";
import { MockEmailAdapter } from "./mock.js";
import { SmtpEmailAdapter, type SmtpConfig } from "./smtp.js";
import type { EmailAdapter } from "./types.js";

const SmtpEnv = z.object({
  SMTP_HOST: z.string("SMTP_HOST is required when EMAIL_ADAPTER=smtp").min(1, "SMTP_HOST is required when EMAIL_ADAPTER=smtp"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
});

/**
 * A blank environment variable is an unset one.
 *
 * `process.env` values are always strings, so a Coolify variable created and
 * left empty — or a `SMTP_PORT=` line in a `.env` — arrives as `""` rather than
 * `undefined`. Zod's `.default()` applies only to `undefined`, so without this
 * `z.coerce.number()` turned `""` into `0`, `.positive()` rejected it, and the
 * worker died at boot on a bare `Invalid input` naming nothing.
 *
 * The same rule, spelled the same way, is `withoutEmptyStrings` in
 * `apps/worker/src/env.ts` and `blankAsUnset` in
 * `packages/integrations/src/adapter-guard.ts`. All three must agree, because
 * the worker parses its env through the first, resolves adapters through the
 * second and builds them through this one — and until they did, the guard
 * printed a healthy environment five lines before the factory threw on it.
 * `packages/integrations/src/adapter-guard.test.ts` runs this factory against
 * that guard case by case and fails if they ever part company again.
 *
 * Exactly `""` is stripped, never a whitespace-only value: `SMTP_HOST=" "` is a
 * mistake worth surfacing as a broken host rather than silently as an absent one.
 */
function withoutEmptyStrings(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
}

/**
 * The SMTP transport this environment describes, or a throw naming the variable.
 *
 * Split out from `createEmailAdapter` so the normalisation above can be tested
 * on its result rather than on an adapter that hides its configuration.
 */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv): SmtpConfig {
  const cfg = SmtpEnv.parse(withoutEmptyStrings(env));
  return { host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, user: cfg.SMTP_USER, pass: cfg.SMTP_PASS, secure: cfg.SMTP_PORT === 465 };
}

/** Mock unless EMAIL_ADAPTER is explicitly "smtp" — mock-first, per CLAUDE.md rule 4. */
export function createEmailAdapter(env: NodeJS.ProcessEnv): EmailAdapter {
  if (withoutEmptyStrings(env).EMAIL_ADAPTER !== "smtp") return new MockEmailAdapter();
  return new SmtpEmailAdapter(smtpConfigFromEnv(env));
}
