import { config } from "dotenv";
config({ path: new URL("../../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });

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
