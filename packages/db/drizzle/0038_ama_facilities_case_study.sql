-- AMA Facilities joins the work.
--
-- Data, not schema, and the same reason as 0031: migration 0025 seeded the
-- portfolio from portfolio-clients.ts and the seed only ever runs once, so a
-- client added to that file afterwards reaches a fresh install and nowhere
-- else. The row has to be said explicitly for the deployment that is already
-- running.
--
-- Idempotent on the slug and inserted for every organisation, so running it
-- twice changes nothing.
--
-- `sort` puts it after everything already there rather than guessing a
-- position; the Case studies screen is where that gets decided.
INSERT INTO "case_studies" (
  "organisation_id", "slug", "name", "client_name", "sector", "summary", "brief",
  "stack", "year", "url", "screenshots", "featured", "kind", "status",
  "delivery_status", "charity", "facts", "sort", "published_at"
)
SELECT
  o."id",
  'ama-facilities',
  'AMA Facilities',
  'AMA Facilities Limited',
  'Commercial cleaning and facilities support',
  'A contract cleaning site built to be shortlisted: every service on its own page, and the specification a facilities manager needs before they will ask for a price.',
  jsonb_build_object(
    'client', 'AMA Facilities Limited is a UK-wide commercial cleaning and facilities support provider, working on contract for offices, retail parks, managed residential blocks, industrial units, schools, healthcare sites and showrooms — from a single site to a multi-site contract.',
    'problem', 'Contract cleaning is bought by facilities managers who are shortlisting, not browsing. They arrive with a specification in mind and leave the moment a site cannot answer it: which services, to what standard, supervised by whom, across how many sites. Most cleaning websites are a phone number and a stock photo of a mop, so the enquiry that follows is a stranger asking questions that should already have been answered.',
    'built', 'A site that reads like a capability statement. Each service — daily and out-of-hours office cleaning, deep cleans, washrooms and consumables, window cleaning, waste and recycling, carpet and floor care, grounds maintenance and small refurbishments — gets its own page, so a search for one lands on that one. The offer that actually wins the contract is the one the site leads with: one provider for cleaning and facilities support, so a managing agent stops holding six relationships. And the things a facilities manager checks before they shortlist are said plainly — written specifications, trained staff, on-site supervision, eco-friendly products and regular contract reviews.',
    'results', 'Live and taking enquiries that already know what they are asking for.'
  ),
  ARRAY['WordPress','Divi','Google Business Profile']::text[],
  2026,
  'https://amafacilities.co.uk',
  '{"desktop":"/work/ama-facilities-desktop.jpg","mobile":"/work/ama-facilities-mobile.jpg"}'::jsonb,
  false,
  'client',
  'published',
  'live',
  false,
  ARRAY[]::text[],
  (SELECT coalesce(max(c2."sort"), -1) + 1 FROM "case_studies" c2 WHERE c2."organisation_id" = o."id"),
  now()
FROM "organisations" o
WHERE NOT EXISTS (
  SELECT 1 FROM "case_studies" c
  WHERE c."organisation_id" = o."id" AND c."slug" = 'ama-facilities'
);
