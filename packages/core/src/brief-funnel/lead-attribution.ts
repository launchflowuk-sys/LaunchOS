import { LeadAttributionSchema, compactAttribution, type LeadAttribution } from "../leads/attribution.js";

/**
 * Turning what the funnel recorded about a visit into what the lead carries.
 *
 * The draft stores campaign metadata as flat snake_case strings, because that
 * is the shape a URL query string arrives in and the shape the allow-list in
 * `sessions.ts` guards. A lead stores it as `metadata.attribution` in
 * camelCase, because that is what `LeadAttributionSchema` validates and what
 * the leads board, the campaign filter and cost-per-lead all read.
 *
 * Nothing joined the two, which is why every lead the brief funnel has ever
 * created shows a blank Campaign column: the tags were captured on the draft
 * and then stayed there. `captureLeadFromDraft` now carries them across.
 *
 * **Two touches, kept apart.** The keys without a prefix are the visit that
 * opened the draft — the acquisition, and the one that must never be
 * overwritten. The `latest_`-prefixed keys are the most recent campaign the
 * same person came back on. A returning ad click should not rewrite history,
 * and it should not be thrown away either.
 */

/** Where `captureLeadFromDraft` stores the most recent touch: `leads.metadata.attributionLatest`. */
export const LATEST_ATTRIBUTION_METADATA_KEY = "attributionLatest";

/** Marks a session-source key as belonging to a later visit rather than the first. */
export const LATEST_TOUCH_PREFIX = "latest_";

/**
 * Session source key → lead attribution field.
 *
 * `entry_route` becomes `landingPath` rather than gaining a field of its own:
 * it is the path the visitor landed on, which is exactly what the marketing
 * site's own cookie already calls `landingPath`, and one name for one thing
 * keeps the leads board from having to know which form produced a row.
 */
const FIELDS: readonly (readonly [key: string, field: keyof LeadAttribution])[] = [
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["utm_term", "utmTerm"],
  ["utm_content", "utmContent"],
  ["utm_id", "utmId"],
  ["gclid", "gclid"],
  ["fbclid", "fbclid"],
  ["gbraid", "gbraid"],
  ["wbraid", "wbraid"],
  ["msclkid", "msclkid"],
  ["ttclid", "ttclid"],
  ["referrer", "referrer"],
  ["plan", "plan"],
  ["entry_route", "landingPath"],
];

/** Every key the funnel may record, first-touch spelling. */
export const CAMPAIGN_SOURCE_KEYS: readonly string[] = FIELDS.map(([key]) => key);

/**
 * The keys that mean "an advert sent this person here".
 *
 * An entry route is not one of them. Recording a second touch for somebody who
 * simply reopened `/start` from a bookmark would make the latest-touch column
 * meaningless within a week.
 */
const CAMPAIGN_ONLY_KEYS: ReadonlySet<string> = new Set(
  CAMPAIGN_SOURCE_KEYS.filter((key) => key !== "entry_route" && key !== "referrer" && key !== "plan"),
);

function map(source: Record<string, string>, prefix: string): LeadAttribution {
  const out: Record<string, string> = {};
  for (const [key, field] of FIELDS) {
    const value = source[`${prefix}${key}`];
    if (typeof value === "string" && value.trim().length > 0) out[field] = value.trim();
  }
  // The same schema `createLead` applies, so a draft cannot put anything on a
  // lead that the contact form could not.
  const parsed = LeadAttributionSchema.safeParse(out);
  return parsed.success ? compactAttribution(parsed.data) : {};
}

/** The campaign that opened the draft. */
export function attributionFromSessionSource(source: Record<string, string> | null | undefined): LeadAttribution {
  return source ? map(source, "") : {};
}

/** The most recent campaign the same person returned on, if there was one. */
export function latestAttributionFromSessionSource(source: Record<string, string> | null | undefined): LeadAttribution {
  return source ? map(source, LATEST_TOUCH_PREFIX) : {};
}

/**
 * Marks a fresh visit's campaign keys as a later touch.
 *
 * Returns `{}` when the visit carried no campaign at all, and when it carried
 * keys that are already prefixed — a caller replaying a stored source must not
 * be able to produce `latest_latest_utm_source`.
 */
export function prefixLatestTouch(source: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!source) return {};
  const out: Record<string, string> = {};
  for (const key of CAMPAIGN_ONLY_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) out[`${LATEST_TOUCH_PREFIX}${key}`] = value.trim();
  }
  return out;
}

/** The latest touch a lead carries, or `{}` for one that only ever had the first. */
export function latestAttributionOf(metadata: Record<string, unknown> | null | undefined): LeadAttribution {
  const parsed = LeadAttributionSchema.safeParse(metadata?.[LATEST_ATTRIBUTION_METADATA_KEY]);
  return parsed.success ? compactAttribution(parsed.data) : {};
}
