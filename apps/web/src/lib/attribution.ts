/**
 * Campaign attribution for a lead: the UTM tags, click ids, landing path and
 * referrer a visitor arrived with, kept for thirty days in a first-party
 * cookie so the enquiry they send on a later visit still says where it came
 * from.
 *
 * A leaf module — no imports from core or the database — because the same
 * helpers run in the browser (`AttributionCapture` writes the cookie on the
 * first page a visitor lands on) and on the server (the contact and sign-up
 * actions read it back). The shape mirrors core's `LeadAttributionSchema`,
 * which is what validates it before `createLead` stores it; nothing here is
 * trusted beyond being a short string, and nothing personal is ever written —
 * no name, no email, no address.
 */

/** The cookie's name. First-party, `SameSite=Lax`, thirty days, no PII. */
export const ATTRIBUTION_COOKIE = "lf_attr";

/** Thirty days, in seconds — the cookie's `Max-Age`. */
export const ATTRIBUTION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type Attribution = {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  landingPath?: string;
  referrer?: string;
  gclid?: string;
  fbclid?: string;
};

const FIELD_MAX = 200;
const PATH_MAX = 500;

/** URL parameter → attribution field. */
const PARAM_FIELDS: readonly (readonly [param: string, field: keyof Attribution])[] = [
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["utm_term", "utmTerm"],
  ["utm_content", "utmContent"],
  ["gclid", "gclid"],
  ["fbclid", "fbclid"],
];

const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  ...PARAM_FIELDS.map(([, field]) => field),
  "landingPath",
  "referrer",
]);

function clip(value: string | null | undefined, max: number): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * The referrer worth keeping: the host of an external page, never a page on
 * our own hosts (a click from the pricing page to the contact page is not a
 * referral) and never a full URL with somebody else's query string in it.
 */
export function externalReferrerHost(referrer: string | null | undefined, ownHosts: readonly string[]): string | undefined {
  const raw = referrer?.trim() ?? "";
  if (raw.length === 0) return undefined;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host.length === 0) return undefined;
  const own = ownHosts.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
  if (own.some((h) => host === h || host === `www.${h}`)) return undefined;
  return clip(host, PATH_MAX);
}

/**
 * What a first visit carries, read off the URL. Empty when the visitor
 * arrived with nothing worth recording — no UTM tag, no click id, no external
 * referrer — so a plain direct visit writes no cookie at all.
 */
export function attributionFromVisit(input: {
  search: string | URLSearchParams;
  pathname: string;
  referrer?: string | null | undefined;
  ownHosts?: readonly string[] | undefined;
}): Attribution {
  const params = typeof input.search === "string" ? new URLSearchParams(input.search) : input.search;
  const out: Attribution = {};
  for (const [param, field] of PARAM_FIELDS) {
    const value = clip(params.get(param), FIELD_MAX);
    if (value) out[field] = value;
  }
  const referrer = externalReferrerHost(input.referrer, input.ownHosts ?? []);
  if (referrer) out.referrer = referrer;
  // The landing path is only meaningful alongside something else: a bare
  // `/pricing` says nothing about where the visitor came from.
  if (Object.keys(out).length > 0) {
    const path = clip(input.pathname, PATH_MAX);
    if (path) out.landingPath = path;
  }
  return out;
}

/** True when there is anything to write. */
export function hasAttribution(attribution: Attribution): boolean {
  return Object.values(attribution).some((v) => typeof v === "string" && v.length > 0);
}

/** The cookie's value: compact JSON, URI-encoded so commas and quotes survive the header. */
export function encodeAttribution(attribution: Attribution): string {
  return encodeURIComponent(JSON.stringify(attribution));
}

/**
 * The attribution a cookie carries, or an empty object for a missing, stale
 * or hand-edited one. Only known keys and string values under the caps get
 * through; the server re-validates with core's Zod schema before storing.
 */
export function decodeAttribution(raw: string | null | undefined): Attribution {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Attribution = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key) || typeof value !== "string") continue;
    const max = key === "landingPath" || key === "referrer" ? PATH_MAX : FIELD_MAX;
    const clipped = clip(value, max);
    if (clipped) out[key as keyof Attribution] = clipped;
  }
  return out;
}

/** The `Set-Cookie`-style string `document.cookie` accepts. `Secure` only over https, so a local run still sets it. */
export function attributionCookieString(attribution: Attribution, secure: boolean): string {
  const parts = [
    `${ATTRIBUTION_COOKIE}=${encodeAttribution(attribution)}`,
    "Path=/",
    `Max-Age=${ATTRIBUTION_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** One cookie's raw value out of a `document.cookie` string. */
export function readCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key?.trim() === name) return rest.join("=").trim();
  }
  return null;
}
