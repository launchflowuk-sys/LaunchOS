# @launchos/web
Next.js 16 app. Route groups: `(admin)` for Shoji/staff, `(portal)` for clients, `api/auth/[...all]` for Better Auth, `api/webhooks/*` for inbound providers (validate + enqueue only), `api/health`.
Planned layout: `src/app`, `src/lib/session.ts`, `src/lib/auth.ts`, `src/lib/db.ts`, `src/components`.
