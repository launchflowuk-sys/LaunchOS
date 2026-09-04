import { defineConfig } from "tsup";

// Bundles apps/worker together with the @launchos/* workspace packages it
// depends on. Those packages ship TypeScript source only (package.json
// `main`/`exports` point at `src/index.ts`, not a compiled `dist/`), which
// works fine for bundler-based consumers (this, and Next.js'
// `transpilePackages` for apps/web) but breaks under a plain `node
// dist/index.js` runtime, which cannot resolve the NodeNext-style `.js`
// specifiers inside that TS source back to their `.ts` files. Bundling here
// with esbuild (which does that `.js` -> `.ts` resolution itself) sidesteps
// the problem instead of relying on each workspace package's own `dist`.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Bundle every @launchos/* workspace package into the output; leave real
  // npm dependencies (pg-boss, drizzle-orm, zod, @anthropic-ai/sdk, ...)
  // external so they're resolved from node_modules at runtime as usual.
  noExternal: [/^@launchos\//],
});
