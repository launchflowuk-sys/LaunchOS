import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

import { defineConfig } from "vitest/config";

export const sharedVitestConfig = defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    passWithNoTests: true,
    /**
     * Bound by one Postgres, not by CPU.
     *
     * Every database-backed test holds a transaction for its whole
     * duration, so the useful parallelism is how many transactions the
     * server will carry — not how many cores are idle. On a 32-core
     * machine vitest ran 32 workers and the suite intermittently lost a
     * different test each time to a `provider timeout`: never the same
     * one, always passing on its own, which reads as flakiness and is
     * really contention. Eight finishes sooner than a run that has to be
     * repeated.
     */
    maxWorkers: Math.min(8, Math.max(2, availableParallelism())),
  },
});
