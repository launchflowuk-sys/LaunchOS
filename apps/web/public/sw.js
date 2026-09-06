/*
 * LaunchOS service worker: web push only.
 *
 * It caches nothing and intercepts no fetches — the admin shell is a live,
 * signed-in app and an offline copy of it would be a stale one. Its whole job
 * is to turn a push message from the worker's `push.send` job into a system
 * notification, and to open the right screen when that notification is
 * tapped. The payload is JSON written by our own worker
 * (`packages/channels` push adapter): `{ title, body, link, tag? }`.
 */

const APP_ORIGIN = self.location.origin;

/** Reads the push payload, tolerating a bare text body from a manual test push. */
function readPayload(event) {
  if (!event.data) return { title: "LaunchOS", body: "", link: "/" };
  try {
    const parsed = event.data.json();
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Not JSON — fall through to the text form.
  }
  return { title: "LaunchOS", body: event.data.text(), link: "/" };
}

/** An in-app path becomes an absolute URL on this origin; anything else opens the dashboard. */
function targetUrl(link) {
  if (typeof link !== "string" || link.length === 0) return `${APP_ORIGIN}/`;
  if (link.startsWith("/")) return `${APP_ORIGIN}${link}`;
  try {
    const url = new URL(link);
    return url.origin === APP_ORIGIN ? url.href : `${APP_ORIGIN}/`;
  } catch {
    return `${APP_ORIGIN}/`;
  }
}

self.addEventListener("install", () => {
  // Replace an older worker straight away: there is no cache to migrate.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  const title = typeof payload.title === "string" && payload.title.length > 0 ? payload.title : "LaunchOS";
  const body = typeof payload.body === "string" ? payload.body : "";
  const url = targetUrl(payload.link);
  // `tag` collapses repeats: the same notification pushed twice (a retry, two
  // devices sharing a browser profile) replaces itself instead of stacking.
  const tag = typeof payload.tag === "string" && payload.tag.length > 0 ? payload.tag : url;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: "/brand/launchflow-logo.png",
      badge: "/brand/launchflow-logo.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || `${APP_ORIGIN}/`;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      // Reuse a tab that is already on the app rather than opening a second
      // one per alert; navigate it to the link the notification carried.
      for (const client of windows) {
        if (client.url.startsWith(APP_ORIGIN) && "focus" in client) {
          if ("navigate" in client && client.url !== url) return client.navigate(url).then((c) => (c ? c.focus() : null));
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
