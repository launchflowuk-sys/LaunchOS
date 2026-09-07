-- Take the old plans off the public pricing page.
--
-- Seventeen plans were on it: bespoke subscriptions negotiated with individual
-- clients over the years — "LaunchFlow Custom Dual Website Plan AMO",
-- "Standard Plan" at £45 sitting beside "Presence" at £45, three separate
-- Cabio tiers — all real numbers for the people who agreed them and all noise
-- to a stranger deciding whether to enquire. That page is the shop window, and
-- it was showing the stockroom.
--
-- Only Presence, Standard and Growth stay listed.
--
-- `active` is display-only, which is why this is safe to do to live plans. It
-- gates the pricing page, self-serve signup and the package the Lead Qualifier
-- may suggest — and nothing else. No client is moved off their plan, no
-- subscription changes, no recurring work stops being generated, and package
-- usage still reports against whatever each client actually holds. AMO carries
-- on exactly as before; their plan simply stops being offered to strangers.
--
-- Reversible from Settings → Packages by ticking one back on.
UPDATE "packages"
SET "active" = false, "updated_at" = now()
WHERE "active" = true
  AND "slug" NOT IN ('presence', 'standard', 'growth');
