"use client";

import { BellRing } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { PUSH_SUBSCRIBE_PATH, SERVICE_WORKER_PATH, subscriptionBody, urlBase64ToUint8Array } from "@/lib/push";

/** One of the member's registered devices, as the server lists them. Endpoints are compared, never shown. */
export type DeviceRow = {
  id: string;
  endpoint: string;
  host: string;
  userAgent: string | null;
  since: string;
  failed: boolean;
};

type Support = "checking" | "unsupported" | "ready";

/** Whether this browser can do web push at all: a worker, a push manager and the Notification API. */
function detectSupport(): Support {
  if (typeof window === "undefined") return "checking";
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window ? "ready" : "unsupported";
}

/** This browser's live push endpoint, or null when it holds no subscription (or the worker never came up). */
async function currentSubscriptionEndpoint(): Promise<string | null> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return subscription?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** A short name for a device row: the browser's own user-agent line, or the push service's host. */
function deviceLabel(device: DeviceRow): string {
  const ua = device.userAgent?.trim();
  if (!ua) return device.host;
  const match = /(iPhone|iPad|Android|Windows|Macintosh|Linux)/.exec(ua);
  const browser = /(Edg|Chrome|Firefox|Safari)\//.exec(ua)?.[1]?.replace("Edg", "Edge");
  const platform = match?.[1]?.replace("Macintosh", "Mac");
  return [browser, platform].filter(Boolean).join(" on ") || device.host;
}

/**
 * "Alerts on this device": the one control that decides whether urgent
 * notifications reach this browser as a system notification.
 *
 * Everything that talks to the browser's push APIs is here; the server is
 * only told the result (`POST`/`DELETE /api/push/subscribe`). The
 * permission prompt is behind the button, never on page load.
 */
export function DeviceAlerts({ vapidPublicKey, devices }: { vapidPublicKey: string | null; devices: readonly DeviceRow[] }) {
  const router = useRouter();
  const [support, setSupport] = useState<Support>("checking");
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Everything is read off the browser first and set in one go afterwards:
    // the push state is an external system, and the answer arrives from it
    // asynchronously (`serviceWorker.ready`).
    let cancelled = false;
    const inspect = async () => {
      const detected = detectSupport();
      const current = detected === "ready" ? await currentSubscriptionEndpoint() : null;
      if (cancelled) return;
      setSupport(detected);
      if (detected === "ready") {
        setPermission(Notification.permission);
        setEndpoint(current);
      }
    };
    void inspect();
    return () => {
      cancelled = true;
    };
  }, []);

  const onThisDevice = endpoint !== null && devices.some((device) => device.endpoint === endpoint);
  const others = devices.filter((device) => device.endpoint !== endpoint);

  async function turnOn() {
    if (!vapidPublicKey) return;
    setBusy(true);
    try {
      const granted = await Notification.requestPermission();
      setPermission(granted);
      if (granted !== "granted") {
        toast.error("Notifications were not allowed, so this device cannot receive alerts.");
        return;
      }
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
        }));
      const body = subscriptionBody(subscription.toJSON());
      if (!body) throw new Error("The browser returned a subscription without keys.");
      const response = await fetch(PUSH_SUBSCRIBE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`The server refused the subscription (${response.status}).`);
      setEndpoint(subscription.endpoint);
      toast.success("Alerts are on for this device");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Alerts could not be switched on.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      const current = subscription?.endpoint ?? endpoint;
      if (current) {
        const response = await fetch(PUSH_SUBSCRIBE_PATH, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: current }),
        });
        // 404 means the server already forgot it: still unsubscribe locally.
        if (!response.ok && response.status !== 404) throw new Error(`The server refused (${response.status}).`);
      }
      await subscription?.unsubscribe();
      setEndpoint(null);
      toast.success("Alerts are off for this device");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Alerts could not be switched off.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
      <p className="text-sm text-muted-foreground">
        Urgent things — an incident opening, a failed payment, an overdue invoice, a case past its response target, a
        send that failed, an approval waiting, the background worker going quiet — arrive on this device as a
        notification, even with LaunchOS closed.
      </p>

      {vapidPublicKey === null ? (
        <InlineAlert tone="info" title="Alerts to devices are not switched on yet">
          Set <code className="font-mono">VAPID_PUBLIC_KEY</code> on the web app and the matching private key on the
          worker, then this button will work.
        </InlineAlert>
      ) : support === "unsupported" ? (
        <InlineAlert tone="warning" title="This browser cannot receive alerts">
          On an iPhone, add LaunchOS to the Home Screen from Safari&apos;s share menu and open it from there; on a desktop,
          use Chrome, Edge, Firefox or Safari 16 or later.
        </InlineAlert>
      ) : permission === "denied" ? (
        <InlineAlert tone="danger" title="Notifications are blocked for this site">
          Allow them in the browser&apos;s site settings, then come back here and turn alerts on.
        </InlineAlert>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-sm">
          <BellRing aria-hidden strokeWidth={1.75} className={onThisDevice ? "size-4 text-success-fg" : "size-4 text-muted-foreground"} />
          {support === "checking"
            ? "Checking this device…"
            : onThisDevice
              ? "This device receives urgent alerts."
              : "This device does not receive alerts."}
        </p>
        {onThisDevice ? (
          <Button type="button" variant="secondary" loading={busy} onClick={turnOff} className="max-sm:w-full">
            Turn off alerts on this device
          </Button>
        ) : (
          <Button
            type="button"
            loading={busy}
            disabled={vapidPublicKey === null || support !== "ready" || permission === "denied"}
            onClick={turnOn}
            className="max-sm:w-full"
          >
            Turn on alerts on this device
          </Button>
        )}
      </div>

      {others.length > 0 ? (
        <div>
          <p className="label-caps text-muted-foreground">Other devices</p>
          <ul className="mt-2 divide-y rounded-lg border">
            {others.map((device) => (
              <li key={device.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2 text-row">
                <span className="font-medium">{deviceLabel(device)}</span>
                <span className="text-meta text-muted-foreground">since {device.since}</span>
                {device.failed ? <span className="text-meta text-danger-fg">last delivery failed</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
