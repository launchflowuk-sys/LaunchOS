import { z } from "zod";

/** Where `createLead` stores the campaign fields: `leads.metadata.attribution`. */
export const ATTRIBUTION_METADATA_KEY = "attribution";

const Field = z.string().trim().max(200);

/**
 * How the enquiry reached us — the UTM tags and click ids the marketing
 * site read off the URL on the visitor's first visit (cookie `lf_attr`) and
 * posted with the form. Every field optional and bounded: it arrives from a
 * public form, and nothing here is trusted beyond being a short string.
 * Stored as jsonb on the lead; no column, no migration.
 */
export const LeadAttributionSchema = z.object({
  utmSource: Field.optional(),
  utmMedium: Field.optional(),
  utmCampaign: Field.optional(),
  utmTerm: Field.optional(),
  utmContent: Field.optional(),
  landingPath: z.string().trim().max(500).optional(),
  referrer: z.string().trim().max(500).optional(),
  gclid: Field.optional(),
  fbclid: Field.optional(),
});
export type LeadAttribution = z.infer<typeof LeadAttributionSchema>;

/** The attribution a lead carries, or an empty object when it has none (or a corrupt one). */
export function attributionOf(metadata: Record<string, unknown> | null | undefined): LeadAttribution {
  const parsed = LeadAttributionSchema.safeParse(metadata?.[ATTRIBUTION_METADATA_KEY]);
  return parsed.success ? parsed.data : {};
}

/** Drops empty strings so `{ utmSource: "" }` does not count as attributed. */
export function compactAttribution(attribution: LeadAttribution): LeadAttribution {
  return Object.fromEntries(Object.entries(attribution).filter(([, value]) => typeof value === "string" && value.length > 0)) as LeadAttribution;
}

/** True when at least one attribution field carries a value. */
export function hasAttribution(attribution: LeadAttribution): boolean {
  return Object.keys(compactAttribution(attribution)).length > 0;
}

/** One line for a bell or a card: "google / cpc / spring-launch". */
export function attributionSummary(attribution: LeadAttribution): string | null {
  const parts = [attribution.utmSource, attribution.utmMedium, attribution.utmCampaign].filter((p): p is string => !!p);
  if (parts.length > 0) return parts.join(" / ");
  if (attribution.gclid) return "Google Ads click";
  if (attribution.fbclid) return "Facebook click";
  if (attribution.referrer) return `Referred from ${attribution.referrer}`;
  return null;
}
