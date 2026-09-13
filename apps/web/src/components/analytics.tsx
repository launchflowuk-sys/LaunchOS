"use client";

import { useEffect, useState } from "react";
import {
  analyticsEnabled,
  rememberConsent,
  setAnalyticsConfig,
  storedConsent,
  type AnalyticsConfig,
} from "@/lib/analytics";

/**
 * Loads the advertising tags, once a visitor has said yes.
 *
 * Renders nothing at all when no ids are configured — no banner, no script, no
 * cookie — which is the state the site ships in and the reason adding this
 * changes nothing visible until Shoji supplies real accounts.
 *
 * Google Consent Mode v2 defaults are pushed **before** gtag.js loads, which is
 * the only order in which a default means anything. A refusal still loads the
 * Google tag so the cookieless ping counts the visit; nothing identifies the
 * visitor and Meta is not loaded at all.
 *
 * Consent lives in `localStorage` for this origin. A visitor who accepted on
 * `grow.launchflow.co.uk` is asked again here, because browsers do not share
 * storage between hostnames — deliberately not worked around with a
 * shared-domain cookie.
 */
export function Analytics({ config }: { config: AnalyticsConfig }) {
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setAnalyticsConfig(config);
    if (!analyticsEnabled(config)) return;

    const w = window as unknown as { dataLayer?: unknown[]; fbq?: unknown };
    w.dataLayer = w.dataLayer ?? [];
    const push = (...args: unknown[]) => w.dataLayer!.push(args);

    if (config.ga4Id) {
      push("consent", "default", {
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "denied",
        functionality_storage: "granted",
        security_storage: "granted",
        wait_for_update: 500,
      });
    }

    let googleLoaded = false;
    const loadGoogle = () => {
      if (googleLoaded || !config.ga4Id) return;
      googleLoaded = true;
      const script = document.createElement("script");
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.ga4Id)}`;
      document.head.appendChild(script);
      push("js", new Date());
      // Keeps the click ids on the URL when storage is refused, which is what
      // lets Ads still attribute a visit it may not cookie.
      push("set", "url_passthrough", true);
      push("config", config.ga4Id);
      if (config.adsConversionId) push("config", config.adsConversionId);
    };

    let metaLoaded = false;
    const loadMeta = () => {
      if (metaLoaded || !config.metaPixelId || w.fbq) return;
      metaLoaded = true;
      const queue: unknown[] = [];
      const stub = (...args: unknown[]) => {
        const live = w.fbq as unknown as { callMethod?: (...a: unknown[]) => void };
        if (live?.callMethod) live.callMethod(...args);
        else queue.push(args);
      };
      Object.assign(stub, { queue, loaded: true, version: "2.0", push: stub });
      w.fbq = stub;
      (window as unknown as { _fbq?: unknown })._fbq = stub;
      const script = document.createElement("script");
      script.async = true;
      script.src = "https://connect.facebook.net/en_US/fbevents.js";
      document.head.appendChild(script);
      stub("init", config.metaPixelId);
      stub("track", "PageView");
    };

    const grant = () => {
      if (config.ga4Id) {
        push("consent", "update", {
          ad_storage: "granted",
          ad_user_data: "granted",
          ad_personalization: "granted",
          analytics_storage: "granted",
        });
      }
      loadGoogle();
      loadMeta();
    };

    const refuse = () => {
      if (!config.ga4Id) return;
      push("consent", "update", {
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "denied",
      });
      loadGoogle();
    };

    const decision = storedConsent();
    if (decision === "granted") grant();
    else if (decision === "denied") refuse();
    else setAsking(true);

    // Stashed so the banner's buttons act on the same closures.
    handlers = { grant, refuse };
  }, [config]);

  if (!asking) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookies"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-[640px] flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_18px_48px_rgba(8,45,70,0.18)]"
    >
      <p className="m-0 flex-1 basis-[280px] text-sm leading-relaxed text-slate-800">
        We use cookies to measure how our ads perform.{" "}
        <a href="/privacy" className="text-[#087caf] underline">
          Privacy
        </a>
        .
      </p>
      <div className="flex flex-none gap-2">
        <button
          type="button"
          onClick={() => {
            rememberConsent("denied");
            handlers?.refuse();
            setAsking(false);
          }}
          className="cursor-pointer rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900"
        >
          No thanks
        </button>
        <button
          type="button"
          onClick={() => {
            rememberConsent("granted");
            handlers?.grant();
            setAsking(false);
          }}
          className="cursor-pointer rounded-full border border-[#087caf] bg-[#087caf] px-4 py-2.5 text-sm font-semibold text-white hover:border-[#066591] hover:bg-[#066591]"
        >
          Accept
        </button>
      </div>
    </div>
  );
}

/**
 * The grant/refuse closures from the effect, so the buttons below it can act
 * on the same `dataLayer` push. A module-level slot rather than state because
 * putting functions in state re-renders the banner for no reason.
 */
let handlers: { grant: () => void; refuse: () => void } | null = null;
