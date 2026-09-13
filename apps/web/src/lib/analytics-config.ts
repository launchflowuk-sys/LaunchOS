import { z } from "zod";
import { EMPTY_ANALYTICS_CONFIG, type AnalyticsConfig } from "./analytics";

/**
 * The advertising account ids, read from the environment on the server.
 *
 * Server-side on purpose. These are not secrets — a pixel id is visible in the
 * page source of every site that uses one — but reading them here rather than
 * as `NEXT_PUBLIC_` variables means they are configured the way everything
 * else in this app is configured: a value in Coolify and a restart, not a
 * rebuild. `NEXT_PUBLIC_` is inlined by `next build`, which would have made
 * correcting a mistyped pixel id a full deploy.
 *
 * Every field is optional and a malformed one is simply dropped: a typo must
 * leave the site running without tags, never refuse to start. The shapes are
 * checked so a value pasted into the wrong box — a `G-` id in the Ads slot —
 * is ignored rather than sent to Google as nonsense.
 */

/** A blank value is an unset one, the rule every other optional key follows. */
const Present = z
  .string()
  .transform((raw) => raw.trim())
  .refine((raw) => raw.length > 0);

const Ga4 = Present.pipe(z.string().regex(/^G-[A-Z0-9]+$/i, "a GA4 id looks like G-XXXXXXXXXX"));
const Ads = Present.pipe(z.string().regex(/^AW-\d+$/i, "an Ads conversion id looks like AW-123456789"));
const Pixel = Present.pipe(z.string().regex(/^\d{5,20}$/, "a Meta pixel id is digits"));
const Label = Present.pipe(z.string().max(60));

function read<T>(schema: z.ZodType<T>, raw: string | undefined): T | null {
  const parsed = schema.safeParse(raw ?? "");
  return parsed.success ? parsed.data : null;
}

export function analyticsConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsConfig {
  const config: AnalyticsConfig = {
    ga4Id: read(Ga4, env.GA4_MEASUREMENT_ID),
    metaPixelId: read(Pixel, env.META_PIXEL_ID),
    adsConversionId: read(Ads, env.GOOGLE_ADS_CONVERSION_ID),
    adsConversionLabel: read(Label, env.GOOGLE_ADS_CONVERSION_LABEL),
  };
  // An Ads conversion needs both halves of `send_to`. One without the other
  // would send `AW-123/null`, which Google accepts and silently never counts.
  if (!config.adsConversionId || !config.adsConversionLabel) {
    return { ...config, adsConversionId: null, adsConversionLabel: null };
  }
  return config;
}

export { EMPTY_ANALYTICS_CONFIG };
