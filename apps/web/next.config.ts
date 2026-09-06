import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

const appDir = dirname(fileURLToPath(import.meta.url));

// The monorepo keeps one .env at the repo root; Next only reads .env files from
// the app directory, so load the root file before the config is evaluated.
loadEnv({ path: resolve(appDir, "../../.env"), quiet: true });

const nextConfig: NextConfig = {
  // The workspace packages ship TypeScript source rather than a build artefact,
  // so Next has to compile them itself.
  transpilePackages: ["@launchos/db", "@launchos/core"],
  outputFileTracingRoot: resolve(appDir, "../.."),
  // Those packages use NodeNext resolution, so their internal imports carry a
  // ".js" specifier that has to be mapped back onto the ".ts" source. Only the
  // webpack bundler supports this (Turbopack has no extensionAlias equivalent),
  // which is why dev and build pass --webpack. Plan 2 should either publish a
  // compiled dist from the workspace packages or move them off NodeNext, and
  // then this app can go back to Turbopack.
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  // Dev-only: let a Cloudflare quick tunnel load the dev server's scripts and HMR
  // resources, so the app can be previewed from a phone. Ignored by next start.
  allowedDevOrigins: ["*.trycloudflare.com"],
  /**
   * Playwright is never bundled into this app.
   *
   * `@launchos/core` re-exports the proposal document's HTML builder, which
   * takes the shared letterhead from `@launchos/channels/pdf` — and that
   * barrel also carries the Chromium renderer, whose `import("playwright")`
   * webpack then follows. Playwright's driver bundle is not bundleable (it
   * reaches for `chromium-bidi` at paths that do not resolve from here) and
   * has no business in a web build in the first place: rendering happens in
   * `apps/worker`, which is the only process with a browser installed.
   *
   * `serverExternalPackages` does not reach it, because the import is issued
   * from a workspace package under `transpilePackages` rather than from
   * node_modules. So it is externalised here for the server — left as a
   * runtime `require` this app never executes — and resolved to nothing for
   * the browser, where a client component that reached it would be a bug
   * worth failing loudly on rather than shipping Postgres to a phone.
   */
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(Array.isArray(config.externals) ? config.externals : [config.externals]).filter(Boolean), "playwright", "playwright-core"];
    } else {
      config.resolve = { ...config.resolve, alias: { ...config.resolve?.alias, playwright: false, "playwright-core": false } };
    }
    return config;
  },
};

export default nextConfig;
