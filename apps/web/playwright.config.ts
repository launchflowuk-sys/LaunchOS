import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// The specs sign in as accounts `pnpm db:seed` created, so they need the same
// SEED_* / DATABASE_URL / INBOUND_EMAIL_SECRET values the seed was run with.
// `pnpm --filter @launchos/web e2e` runs from apps/web, so the repo-root .env
// is two levels up; the local one is a fallback for a differently-rooted run.
// dotenv never overwrites a variable that is already set, so a value exported
// on the command line still wins.
for (const candidate of ["../../.env", ".env"]) {
  loadEnv({ path: resolve(process.cwd(), candidate), quiet: true });
}

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  // First visits compile routes in `next dev`; a 5s expect default turns every cold
  // route into a flake, so the default matches the slowest observed compile.
  expect: { timeout: 45_000 },
  // And the per-test cap has to clear the expects inside it. Playwright's
  // default is 30s, which quietly overrode every `COLD_COMPILE` wait in the
  // specs: a test allowed 120s for one assertion was killed at 30s having
  // never been allowed to make it. A signed-in journey that compiles a public
  // page, an auth page and an admin page in one test needs the room.
  timeout: 180_000,
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
