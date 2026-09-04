/**
 * Runs the web app's environment validation once, at server start.
 *
 * `src/lib/env.ts` validates on import — which under `next start` means "on the
 * first request that reaches a route importing it". Only five server-action
 * modules do, and the modules that actually build an email adapter
 * (`invoices/actions.ts`, `settings/email/actions.ts`, `lib/agent-catalog.ts`)
 * are not among them. So a production web container deployed without
 * `EMAIL_ADAPTER` used to start, pass `/api/health`, render the dashboard, send
 * invoices through `MockEmailAdapter`, and never print the `web adapters` line
 * that `docs/DEPLOYMENT.md` tells the operator to check after every redeploy.
 *
 * `register()` is Next's one guaranteed pre-request hook: it is called once per
 * server instance and must finish before the server handles a request
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`).
 * A throw here aborts the boot — which is the point. The refusal is now a
 * container that will not come up, not a 500 on whichever route someone visits
 * fifth.
 *
 * Guarded to the Node runtime: `register()` also runs in the Edge runtime,
 * where `@launchos/integrations` and the Zod env schema have no business being
 * loaded, and where nothing sends mail.
 *
 * Next skips `register()` entirely during `phase-production-build`
 * (`node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js`),
 * so this adds nothing to the build. The `NEXT_PHASE` exemption inside
 * `lib/env.ts` still has to stay: `next build` imports those five action
 * modules directly, and reaches the module that way rather than through here.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("./lib/env");
}
