import { HttpUptimeProbe, MockUptimeProbe, type UptimeProbe } from "./uptime/index.js";
import { MockHostingProvider, type HostingProvider } from "./coolify/index.js";
import { createPaymentsAdapter, type PaymentsAdapter } from "./payments/index.js";
import { createAdsAdapter, type AdsAdapter } from "./ads/index.js";

export * from "./uptime/index.js";
export * from "./coolify/index.js";
export * from "./payments/index.js";
export * from "./ads/index.js";

export interface Integrations {
  uptime: UptimeProbe;
  hosting: HostingProvider;
  payments: PaymentsAdapter;
  ads: AdsAdapter;
}

function parseDownUrls(value: string | undefined): Set<string> {
  if (!value) return new Set<string>();
  return new Set(
    value
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0),
  );
}

export function createIntegrations(env: NodeJS.ProcessEnv): Integrations {
  const uptime =
    env.UPTIME_PROBE === "http" ? new HttpUptimeProbe() : new MockUptimeProbe(parseDownUrls(env.MOCK_DOWN_URLS));
  const hosting = new MockHostingProvider(); // real Coolify client arrives with a later plan
  return { uptime, hosting, payments: createPaymentsAdapter(env), ads: createAdsAdapter(env) };
}
