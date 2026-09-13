/**
 * Ad measurement for the marketing site — dormant until it is configured.
 *
 * A leaf module with no imports, because it runs in the browser: a value
 * import from `@launchos/core` here would drag the database driver into the
 * client bundle and fail the build with `Can't resolve 'net'`.
 *
 * **Configured at runtime, not at build time.** The ids are read from
 * `process.env` in the marketing layout — a server component — and handed to
 * the `<Analytics>` client component as props. `NEXT_PUBLIC_` variables would
 * have been the obvious choice and are the wrong one: Next inlines those when
 * `next build` runs, so changing a pixel id would mean a rebuild and a deploy
 * rather than editing a variable in Coolify and restarting, which is how every
 * other secret in this repo behaves.
 *
 * With no ids set, nothing here does anything: no script is fetched, no cookie
 * is written, no banner is drawn.
 *
 * ## The one primary conversion
 *
 * `reportLeadSubmitted` is called in exactly one place — after
 * `/api/brief-funnel/submit` has returned a reference, which means the server
 * has committed the brief. Not on a button press, not on reaching the last
 * step, not on rendering a thank-you screen. Those all fire for people who
 * never enquired, and an ad platform told to optimise for them will go and buy
 * more of them.
 *
 * The brief reference is the deduplication key for both platforms: it is
 * stable, the server minted it, and a retried submission returns the same one
 * because `/submit` is idempotent. Meta's browser and server copies of one
 * event deduplicate on matching `event_name` **and** `event_id`, so a future
 * Conversions API sender must use `Lead` and this same reference — see
 * `docs/ADVERTISING.md`.
 */

export interface AnalyticsConfig {
  /** `G-XXXXXXXXXX`. */
  ga4Id: string | null;
  /** Meta pixel / dataset id. */
  metaPixelId: string | null;
  /** `AW-XXXXXXXXX`. */
  adsConversionId: string | null;
  /** The conversion action's label, the half after the slash in `send_to`. */
  adsConversionLabel: string | null;
}

export const EMPTY_ANALYTICS_CONFIG: AnalyticsConfig = {
  ga4Id: null,
  metaPixelId: null,
  adsConversionId: null,
  adsConversionLabel: null,
};

/** True when there is at least one tag to load — and therefore consent to ask for. */
export function analyticsEnabled(config: AnalyticsConfig): boolean {
  return Boolean(config.ga4Id || config.metaPixelId);
}

/** The choice a visitor made, stored per origin. */
export const CONSENT_KEY = "lf_consent";
export type Consent = "granted" | "denied";

export function storedConsent(): Consent | null {
  try {
    const value = window.localStorage.getItem(CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : null;
  } catch {
    // A browser refusing storage is a visitor we simply do not measure.
    return null;
  }
}

export function rememberConsent(value: Consent): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    /* The banner reappears next visit. The site still works. */
  }
}

/**
 * The live configuration, set once by `<Analytics>` when it mounts.
 *
 * A module-level value rather than context because the one caller that needs
 * it — the brief funnel's success path — is several components away and would
 * otherwise have to thread a provider through a form that has nothing to do
 * with advertising.
 */
let config: AnalyticsConfig = EMPTY_ANALYTICS_CONFIG;

export function setAnalyticsConfig(next: AnalyticsConfig): void {
  config = next;
}

type Gtag = (...args: unknown[]) => void;

function gtag(): Gtag | null {
  const w = window as unknown as { gtag?: Gtag; dataLayer?: unknown[] };
  if (!w.dataLayer) return null;
  return (
    w.gtag ??
    function pushed(...args: unknown[]) {
      w.dataLayer!.push(args);
    }
  );
}

function fbq(): ((...args: unknown[]) => void) | null {
  const w = window as unknown as { fbq?: (...args: unknown[]) => void };
  return typeof w.fbq === "function" ? w.fbq : null;
}

/** Guards against a second render, a back navigation or a re-mount counting twice. */
function alreadyReported(reference: string): boolean {
  const key = `lf_conv_${reference}`;
  try {
    if (window.localStorage.getItem(key)) return true;
    window.localStorage.setItem(key, "1");
    return false;
  } catch {
    // No storage means no guard. Firing once more is better than never firing,
    // and the platforms deduplicate on the event id anyway.
    return false;
  }
}

/**
 * The primary conversion: a brief the backend has confirmed.
 *
 * Safe to call when nothing is configured, when consent was refused and when
 * the scripts were blocked — each is a no-op rather than a throw, because a
 * measurement failure must never be what stops a customer seeing their
 * reference number.
 */
export function reportLeadSubmitted(reference: string): void {
  if (typeof window === "undefined" || !reference) return;
  try {
    if (alreadyReported(reference)) return;

    const g = gtag();
    if (g && config.ga4Id) {
      // GA4's recommended event for exactly this. No revenue value: an enquiry
      // is not a sale, and inventing a number teaches Smart Bidding a lie.
      g("event", "generate_lead", { transaction_id: reference });
    }
    if (g && config.adsConversionId && config.adsConversionLabel) {
      g("event", "conversion", {
        send_to: `${config.adsConversionId}/${config.adsConversionLabel}`,
        transaction_id: reference,
      });
    }

    const f = fbq();
    // `eventID` — Meta's spelling — is what makes a future server-side copy of
    // this same event deduplicate rather than double-count.
    if (f && config.metaPixelId) f("track", "Lead", {}, { eventID: reference });
  } catch {
    /* Measurement is never allowed to break the page. */
  }
}
