# Client reviews endpoint — brief for the LaunchOS session (14 Sep 2026)

Every LaunchFlow client site should show its Google reviews on its homepage without
holding a Google key or building anything. LaunchOS already knows each client site
(the `sites` table, `hosting_ref` for Coolify). Add reviews to it.

## What to build

1. **Per-site settings**: `google_place_id` (text), `reviews_enabled` (bool), set in
   the site's settings screen. Optional later: Business Profile OAuth per client.
2. **Fetcher**: a daily job (and a "refresh now" button) that calls Google Places
   Details for the place id with fields `rating,user_ratings_total,reviews,url`
   (Places returns at most five reviews; that is fine for a homepage band), stores
   `rating`, `count`, `reviews[] { author, rating, text, relative_time, time,
   profile_photo_url }`, `google_url`, `fetched_at` on the site row or a
   `site_reviews` table. Key: the existing Google API key in LaunchOS env
   (`GOOGLE_MAPS_API_KEY`; add it if absent, Places API enabled).
3. **Public read endpoint**: `GET /api/public/reviews?site=<slug>` → `{ ok, data: {
   name, rating, count, url, fetchedAt, reviews: [...] } }`, no auth, CORS open,
   `Cache-Control: public, max-age=3600`, 404 for unknown/disabled sites, never the
   raw Google payload. Rate limited per IP.
4. **Later** (separate ticket): Google Business Profile OAuth per client so LaunchOS
   can read all reviews and post replies from the client's dashboard.

## Consumers

Nasir Car Home (slug `nasir-car-home`) and Auto Care Garage (slug `autocare`)
already render a reviews band from this endpoint and hide it when the endpoint is
missing or empty. Their env: `LAUNCHOS_REVIEWS_URL=https://os.launchflow.co.uk/api/public/reviews`.

Blockers on the client side: both businesses need a claimed Google Business
Profile and its place id entered here.

## Exact shape the client sites validate (they drop the band on anything else)

- `time`: Unix seconds (Places' value). The sites render "2 months ago" in EN/UR
  from it; `relative_time` is only a fallback.
- `profile_photo_url`: absolute `https://lh3.googleusercontent.com/...` or omitted.
- `count`: Google's `user_ratings_total`, not `reviews.length`; reviews with empty
  `text` are dropped and at most five are shown.
- `url`: absolute Google Maps URL for the listing.
- Unknown or disabled site → plain `404`; the sites cache a failure for 5 minutes.

## Count matters (14 Sep 2026)

The client sites now show six reviews on desktop and a two-row marquee on phones.
Places Details caps at five reviews, so with Places alone the desktop grid shows
five. Promote the Business Profile OAuth step from "later" to the next item: with
the owner's Google sign-in the endpoint can return all reviews (send up to 12,
newest first, the sites take what they need) and LaunchOS can offer reply-from-
dashboard, which is a billable feature for every client.
