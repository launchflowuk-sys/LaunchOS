import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { z } from "zod";

// The worker's cwd at runtime may not be the repo root (e.g. `tsx watch src/index.ts`
// run from apps/worker, or a process manager with a different cwd), so load the
// repo-root .env by resolving it relative to this file rather than relying on cwd.
// A missing .env is not an error — production sets real env vars instead.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

export const Env = z.object({
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
});
export type Env = z.infer<typeof Env>;

// process.env values are always strings, so an unset-but-present var (e.g.
// `ANTHROPIC_API_KEY=` in .env.example) comes through as "" rather than
// undefined and would otherwise fail `.optional()` validators. Treat empty
// strings the same as unset before parsing.
function withoutEmptyStrings(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
}

export const env = Env.parse(withoutEmptyStrings(process.env));
