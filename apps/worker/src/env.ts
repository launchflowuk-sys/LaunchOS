import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { productionAdapterIssues, productionMockWarnings } from "@launchos/integrations";
import { z } from "zod";

// The worker's cwd at runtime may not be the repo root (e.g. `tsx watch src/index.ts`
// run from apps/worker, or a process manager with a different cwd), so load the
// repo-root .env by resolving it relative to this file rather than relying on cwd.
// A missing .env is not an error — production sets real env vars instead.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

/**
 * The base URL this worker assumes when `APP_URL` is unset.
 *
 * Same constant, same reasoning as `apps/web/src/lib/env.ts`: fine for every
 * internal link and wrong for the one string a client clicks, so the rule below
 * refuses it under `NODE_ENV=production`.
 */
export const LOCAL_APP_URL = "http://localhost:3000";

const EnvShape = z.object({
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Only for an organisation-level key: the workspace the requests belong to. */
  ANTHROPIC_WORKSPACE_ID: z.string().optional(),
  AGENT_MODEL: z.string().default("claude-opus-5"),
  AGENT_POLICY: z.enum(["safe", "approval_all"]).default("safe"),
  UPTIME_PROBE: z.enum(["mock", "http"]).default("mock"),
  LLM: z.enum(["anthropic", "fake"]).default("anthropic"),
  EMAIL_ADAPTER: z.enum(["mock", "smtp"]).default("mock"),
  SUPPORT_EMAIL_DOMAIN: z.string().min(3).optional(),
  MAIL_FROM: z.string().optional(),
  INBOUND_EMAIL_ENABLED: z.string().optional(),
  OWNER_NOTIFY_EMAIL: z.string().email().optional(),
  STORAGE_DIR: z.string().default("./storage"),
  APP_URL: z.string().url().default(LOCAL_APP_URL),
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
  /**
   * Read only by the adapter guard below; the factories read them from
   * `process.env` themselves.
   *
   * They have to be declared all the same. `superRefine` receives the *parsed*
   * object and `z.object` strips every key it does not declare, so a variable
   * the guard reads and this schema omits arrives as `undefined` — which reads
   * as unset. Before `SMTP_HOST` was listed here, adding the SMTP rule to
   * `productionAdapterIssues` would have refused every correctly configured
   * production worker. Anything added to `AdapterEnv` belongs here too.
   */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  /**
   * The real hosting, DNS, CMS and ads adapters. Same rule as the Stripe and
   * SMTP keys above: each factory reads its own keys from `process.env`, and
   * they are declared here so the adapter guard sees them. `ADS_ADAPTER` is
   * now an *intent* — the ads factory selects by credential — kept so a
   * deployment that means to run Google or Meta is refused, not quietly
   * reverted to the mock, when its keys go missing. Blank means unset
   * throughout (`withoutEmptyStrings` below).
   */
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
  /**
   * The same escape hatch as `ALLOW_FAKE_LLM`, for the adapters: a production
   * deployment that genuinely means to run on mocks (a staging resource, a dry
   * run before the SPF and DKIM records verify) says so out loud.
   */
  ALLOW_MOCK_ADAPTERS: z.string().optional(),
  /**
   * Where `GET /health` answers (`apps/worker/src/health.ts`) — the port
   * Coolify's health check and a curious operator hit. `0` asks the OS for a
   * free port, which the tests use.
   */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  /**
   * Web push. Read by `createPushAdapterFromEnv` in `packages/channels` from
   * `process.env`; declared here so the adapter guard sees them (same rule as
   * the SMTP and Stripe keys above). Both keys set → real push; unset → the
   * mock, tolerated with a warning; keys without `VAPID_SUBJECT` → refused.
   */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
});

/**
 * Four rules no single field can express, all about the same failure: a worker
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
 *    web app applies exactly the same one. The hosting, DNS, CMS and ads
 *    adapters are the exception by design — unset, they are tolerated and
 *    warned about in `loadEnv` (`productionMockWarnings`), because production
 *    was already running with none of their keys when their real clients
 *    landed; set-but-unusable is still refused.
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
  // 4. `APP_URL` is a real address in production, not the local default. The
  //    worker hands it to the agent registry as `portalBaseUrl`, and the Ad
  //    Performance Sentinel and every approved portal reply put it in an email
  //    a client is asked to click. The default is checked by value rather than
  //    by absence because `APP_URL=http://localhost:3000` set on a live
  //    resource does exactly the same damage as leaving it unset.
  if (value.NODE_ENV === "production" && value.APP_URL.replace(/\/$/, "") === LOCAL_APP_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["APP_URL"],
      message:
        `APP_URL is ${LOCAL_APP_URL} in production: a client emailed a portal link would be sent to their own machine. ` +
        "Set it to the address the web app is served from, e.g. https://os.launchflow.co.uk",
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

/** A logger that only needs the two levels `loadEnv` uses. */
type EnvLogger = Pick<Console, "info" | "warn">;

/**
 * The one line that says whether the guards above are armed.
 *
 * Every production rule in this file — `LLM=fake`, and every adapter rule in
 * `productionAdapterIssues` — is keyed on `NODE_ENV === "production"`, and Node
 * does not default `NODE_ENV`. A worker started without it therefore passes all
 * of them by *not being production*, which looks identical in the log to
 * passing them on merit. `infra/Dockerfile.worker` now sets it, and
 * `docs/DEPLOYMENT.md` step 4 lists it, but neither can prove it survived a
 * redeploy — so the process says out loud which of the two it is.
 *
 * Deliberately a warning and not a refusal: the guard semantics stay keyed on
 * `NODE_ENV` alone (no host-sniffing of `DATABASE_URL` — see the bootstrap note
 * in `docs/DEPLOYMENT.md`, "no string test can tell a local database from a
 * live one"), and every local `pnpm dev:worker` runs with it unset.
 */
export function describeNodeEnv(nodeEnv: string | undefined): { level: keyof EnvLogger; message: string } {
  if (!nodeEnv) {
    return {
      level: "warn",
      message:
        "NODE_ENV unset: production guards are OFF — mock adapters and LLM=fake would be accepted. " +
        "Expected on a local worker; on a deployed one set NODE_ENV=production.",
    };
  }
  return { level: "info", message: `NODE_ENV=${nodeEnv}` };
}

/**
 * The validated environment, read once at startup.
 *
 * Called from `main()` rather than evaluated at import: the rules above are
 * deliberately strict enough to refuse a real developer's shell (a checked-out
 * `.env` has `ANTHROPIC_API_KEY=` empty), and a module that throws on import
 * cannot be tested, or imported by anything that does not intend to boot a
 * worker. `main()` is the one place that intends to.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env, logger: EnvLogger = console): Env {
  if (cached) return cached;
  cached = parseEnv(source);
  const line = describeNodeEnv(cached.NODE_ENV);
  logger[line.level](line.message);
  // One line per mock a production process is about to run on — the ones
  // the guard tolerates unset, and the refused ones ALLOW_MOCK_ADAPTERS let
  // through. Names and consequences only; never a value.
  for (const warning of productionMockWarnings(cached)) logger.warn(warning.message);
  return cached;
}
