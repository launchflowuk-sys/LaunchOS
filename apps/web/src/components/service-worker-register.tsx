"use client";

import { useEffect } from "react";
import { SERVICE_WORKER_PATH } from "@/lib/push";

/**
 * Registers `public/sw.js` once the admin shell has mounted.
 *
 * Registration is idempotent — the browser keeps one worker per scope and a
 * second call returns the same registration — so this can sit in the layout
 * and run on every page without stacking workers. Nothing here asks for
 * notification permission: that is a decision the member makes on `/account`,
 * behind a button, never a prompt that appears because a page loaded.
 *
 * Renders nothing.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(SERVICE_WORKER_PATH).catch((error: unknown) => {
      // A failed registration only means this device cannot receive alerts;
      // the account page reports that state on its own.
      console.warn("service worker registration failed", error);
    });
  }, []);
  return null;
}
