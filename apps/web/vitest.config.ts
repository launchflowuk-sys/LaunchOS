import { fileURLToPath } from "node:url";
import { sharedVitestConfig } from "@launchos/config/vitest.shared";
import { defineConfig, mergeConfig } from "vitest/config";

// Route handler tests import via the app's own "@/..." alias (the same one
// Next.js and tsconfig resolve), which the shared config knows nothing about —
// this merges that alias in on top of everything else the shared config sets.
export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
  }),
);
