"use client";

import { useEffect } from "react";
import {
  ATTRIBUTION_COOKIE,
  attributionCookieString,
  attributionFromVisit,
  hasAttribution,
  readCookieValue,
} from "@/lib/attribution";

/**
 * Writes the `lf_attr` cookie on a visitor's first landing.
 *
 * Renders nothing. On mount it reads the UTM tags and click ids off the URL
 * and the referrer off the document, and — only when there is something to
 * keep and no cookie yet — stores them for thirty days. "First visit wins":
 * a later page carrying different tags never overwrites the campaign that
 * actually brought the visitor. The contact and sign-up actions read the
 * cookie back on the server and pass it to `createLead` as attribution.
 *
 * A client component because a cookie cannot be set from a server component
 * in Next (only from an action or a route handler), and because the referrer
 * is only known to the browser. It runs on every marketing page and on
 * `/signup`, which is where a paid click lands.
 */
export function AttributionCapture({ ownHosts }: { ownHosts: readonly string[] }) {
  useEffect(() => {
    try {
      if (readCookieValue(document.cookie, ATTRIBUTION_COOKIE)) return;
      const attribution = attributionFromVisit({
        search: window.location.search,
        pathname: window.location.pathname,
        referrer: document.referrer,
        ownHosts,
      });
      if (!hasAttribution(attribution)) return;
      document.cookie = attributionCookieString(attribution, window.location.protocol === "https:");
    } catch {
      // A browser that refuses cookies is a visitor with no campaign, nothing more.
    }
  }, [ownHosts]);
  return null;
}
