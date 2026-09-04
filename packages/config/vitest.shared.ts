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
  },
});
