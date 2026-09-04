import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { productionAdapterIssues } from "@launchos/integrations";
import { z } from "zod";

// The worker's cwd at runtime may not be the repo root (e.g. `tsx watch src/index.ts`
// run from apps/worker, or a process manager with a different cwd), so load the
// repo-root .env by resolving it relative to this file rather than relying on cwd.
// A missing .env is not an error — production sets real env vars instead.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const EnvShape = z.object({
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AGENT_MODEL: z.string().default("claude-opus-5"),
  AGENT_POLICY: z.enum(["safe", "approval_all"]).default("safe"),
  UPTIME_PROBE: z.enum(["mock", "http"]).default("mock"),
  LLM: z.enum(["anthropic", "fake"]).default("anthropic"),
  EMAIL_ADAPTER: z.enum(["mock", "smtp"]).default("mock"),
  SUPPORT_EMAIL_DOMAIN: z.string().min(3).optional(),
  MAIL_FROM: z.string().optional(),
  OWNER_NOTIFY_EMAIL: z.string().email().optional(),
  STORAGE_DIR: z.string().default("./storage"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  PAYMENTS_ADAPTER: z.enum(["mock", "stripe"]).default("mock"),
  ADS_ADAPTER: z.enum(["mock", "google", "meta"]).default("mock"),
  VAT_RATE: z.coerce.number().min(0).max(100).default(20),
  NODE_ENV: z.string().optional(),
  /**
   * The one way to run the fake LLM in production, and it has to be typed out
   * on purpose. Without it a mis-set `LLM` would boot a worker whose agents
   * answer from a scripted stub — silently, and with real clients on the other
   * end of the approvals it raises.
   */
  ALLOW_FAKE_LLM: z.string().optional(),
  /** Read only by the adapter guard below; `createPaymentsAdapter` reads them from `process.env` itself. */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /**
   * The same escape hatch as `ALLOW_FAKE_LLM`, for the adapters: a production
   * deployment that genuinely means to run on mocks (a staging resource, a dry
   * run before the SPF and DKIM records verify) says so out loud.
   */
  ALLOW_MOCK_ADAPTERS: z.string().optional(),
});

/**
 * Three rules no single field can express, all about the same failure: a worker
 * that boots happily and then cannot do the thing it was deployed to do.
 *
 * 1. `LLM=anthropic` (the default) needs `ANTHROPIC_API_KEY`. Without it every
 *    agent run fails at its first LLM call — after `RunRecorder.open` has
 *    inserted the run — so the damage is a queue full of failed runs and an
 *    error nobody sees until they read the log. Refusing at startup is loud,
 *    immediate and points at the missing variable.
 * 2. `LLM=fake` is refused under `NODE_ENV=production` unless `ALLOW_FAKE_LLM=1`.
 *    The fake client is a scripted stub; a production worker running it would
 *    file tickets and raise approvals from canned text.
 * 3. The same rule for every adapter that can silently resolve to a mock, which
 *    is worse than the LLM case because a mock *succeeds*: `MockEmailAdapter`
 *    returns a message id, so a worker without `EMAIL_ADAPTER=smtp` marks every
 *    reply, ad report and invoice email `sent` and delivers none of them. The
 *    rule itself is `productionAdapterIssues` in `packages/integrations`, so the
 *    web app applies exactly the same one.
 */
export const Env = EnvShape.superRefine((value, ctx) => {
  if (value.LLM === "anthropic" && !value.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["ANTHROPIC_API_KEY"],
      message:
        "ANTHROPIC_API_KEY is required when LLM=anthropic (the default). Set the key, or set LLM=fake for local work without one.",
    });
  }
  if (value.LLM === "fake" && value.NODE_ENV === "production" && value.ALLOW_FAKE_LLM !== "1") {
    ctx.addIssue({
      code: "custom",
      path: ["LLM"],
      message:
        "LLM=fake is refused in production: the agents would answer from a scripted stub. Set ANTHROPIC_API_KEY and LLM=anthropic, or set ALLOW_FAKE_LLM=1 to say you meant it.",
    });
  }
  for (const issue of productionAdapterIssues(value)) {
    ctx.addIssue({ code: "custom", path: [issue.variable], message: issue.message });
  }
});
export type Env = z.infer<typeof Env>;

// process.env values are always strings, so an unset-but-present var (e.g.
// `ANTHROPIC_API_KEY=` in .env.example) comes through as "" rather than
// undefined and would otherwise fail `.optional()` validators. Treat empty
// strings the same as unset before parsing.
function withoutEmptyStrings(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
}

/** Exported so the rules above can be tested without mutating `process.env`. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  return Env.parse(withoutEmptyStrings(source));
}

let cached: Env | undefined;

/**
 * The validated environment, read once at startup.
 *
 * Called from `main()` rather than evaluated at import: the rules above are
 * deliberately strict enough to refuse a real developer's shell (a checked-out
 * `.env` has `ANTHROPIC_API_KEY=` empty), and a module that throws on import
 * cannot be tested, or imported by anything that does not intend to boot a
 * worker. `main()` is the one place that intends to.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  cached ??= parseEnv(source);
  return cached;
}
