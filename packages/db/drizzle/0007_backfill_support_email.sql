-- Data-only migration. Migration 0003 added `clients.support_email` and backfilled
-- `clients.slug`, but left `support_email` NULL on every row that predates it, so
-- older clients have no address for Plan 4's inbound routing to match on.
-- `createClient` derives the address as `<slug>@<SUPPORT_EMAIL_DOMAIN>`; a migration
-- cannot read env, so this uses the same literal fallback as
-- DEFAULT_SUPPORT_EMAIL_DOMAIN in packages/core/src/config.ts. Deployments that set
-- SUPPORT_EMAIL_DOMAIN to something else should re-point these rows after applying.
-- The `clients_support_email` unique index is satisfied because `slug` is already
-- unique per organisation and only one organisation exists today.
UPDATE "clients" SET "support_email" = "slug" || '@' || 'support.launchflow.co.uk' WHERE "support_email" IS NULL;
