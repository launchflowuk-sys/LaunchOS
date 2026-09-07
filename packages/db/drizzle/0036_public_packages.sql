-- The three packages the public page offers, as agreed on 7 Sep 2026.
--
-- Presence £45, Standard £110, Growth £220. Every figure is its components
-- added up — £45 a site, £65 content and social, £100–110 ad management — which
-- is how the AMO account already prices, so quoting a second site or a second
-- set of ads stays arithmetic rather than a fresh negotiation.
--
-- Inserted for every organisation and idempotent on the slug, so running it
-- twice changes nothing and a second tenant gets the same catalogue.
--
-- It deliberately does NOT retire the older packages. Live clients are attached
-- to those rows, and deciding which of them is finished is Shoji's call with
-- the client list in front of him — not something a migration should guess at
-- half four in the morning. Until he does, the page will show both sets.
INSERT INTO "packages" ("organisation_id", "name", "slug", "description", "monthly_price_pence", "setup_price_pence", "currency", "includes", "active")
SELECT
  o."id",
  v."name",
  v."slug",
  v."description",
  v."monthly",
  0,
  'GBP',
  v."includes"::jsonb,
  true
FROM "organisations" o
CROSS JOIN (VALUES
  (
    'Presence', 'presence',
    'Your website looked after: hosting, security updates, backups, monitoring and a monthly report showing what was done. Small changes whenever you need them.',
    4500,
    '{"website":true,"seo":false,"ads":false,"socialPostsPerMonth":0,"blogPostsPerMonth":0,"gbpUpdatesPerMonth":0}'
  ),
  (
    'Standard', 'standard',
    'Everything in Presence, plus somebody writing for you every month — social posts, articles and Google Business updates, published and reported on.',
    11000,
    '{"website":true,"seo":true,"ads":false,"socialPostsPerMonth":8,"blogPostsPerMonth":4,"gbpUpdatesPerMonth":4}'
  ),
  (
    'Growth', 'growth',
    'Everything in Standard, plus your advertising managed — and me on the end of the phone: a monthly call, same-day replies on a working day, and WhatsApp.',
    22000,
    '{"website":true,"seo":true,"ads":true,"socialPostsPerMonth":8,"blogPostsPerMonth":6,"gbpUpdatesPerMonth":4}'
  )
) AS v("name", "slug", "description", "monthly", "includes")
ON CONFLICT DO NOTHING;
