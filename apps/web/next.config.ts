import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// The monorepo keeps one .env at the repo root; Next only reads .env files from
// the app directory, so load the root file before the config is evaluated.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true });

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, not a build artefact.
  transpilePackages: ["@launchos/db", "@launchos/core"],
  outputFileTracingRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
};

export default nextConfig;
