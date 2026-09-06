-- LifeStyle Windows joins the featured four on the home page.
--
-- Data, not schema: migration 0025 seeded the portfolio from
-- `packages/core/src/case-studies/portfolio-clients.ts`, where this row was
-- `featured: false`. The seed has been corrected so a fresh install is right,
-- but the seed only ever runs once — an organisation that already has the row
-- keeps whatever it was given, so the live one needs saying explicitly.
--
-- Scoped to the slug and to rows that are still unfeatured, so it is idempotent
-- and cannot undo a later decision made on the Case studies screen.
UPDATE "case_studies"
SET "featured" = true, "updated_at" = now()
WHERE "slug" = 'lifestyle-windows' AND "featured" = false;
