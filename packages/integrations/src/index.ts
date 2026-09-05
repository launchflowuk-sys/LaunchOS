import { HttpUptimeProbe, MockUptimeProbe, type UptimeProbe } from "./uptime/index.js";
import { createHostingProviderFromEnv, type HostingProvider } from "./coolify/index.js";
import { createPaymentsAdapter, type PaymentsAdapter } from "./payments/index.js";
import { createAdsAdapterFromEnv, type AdsAdapter } from "./ads/index.js";
import type { DnsProvider } from "./cloudflare/index.js";
import { createDnsProvidersFromEnv } from "./dns/index.js";
import { createCmsProviderFromEnv, type CmsProvider, type CmsProviderDeps } from "./cms/index.js";
import { createSocialPublisherFromEnv, type SocialPublisher } from "./social/index.js";

export * from "./uptime/index.js";
export * from "./coolify/index.js";
export * from "./payments/index.js";
export * from "./ads/index.js";
export * from "./cloudflare/index.js";
export * from "./dns/index.js";
export * from "./cms/index.js";
export * from "./social/index.js";
export * from "./adapter-guard.js";

export interface Integrations {
  uptime: UptimeProbe;
  hosting: HostingProvider;
  payments: PaymentsAdapter;
  ads: AdsAdapter;
  /** A per-domain registry (`dns.for?.(provider)`), not a single provider. */
  dns: DnsProvider;
  cms: CmsProvider;
  /** Facebook Pages and Instagram, on the same Meta system-user token as `ads`. */
  social: SocialPublisher;
}

/**
 * What a caller can hand `createIntegrations` beyond the environment.
 *
 * Only the CMS needs anything: its credentials are held per site, encrypted,
 * in a database this package does not know about. `apps/web` and `apps/worker`
 * pass `siteCredentialResolver(db, organisationId)` from `@launchos/core` —
 * bound to one organisation, so the provider can only ever reach a site that
 * tenant owns. Without it the real provider is still selected when
 * `SECRETS_ENCRYPTION_KEY` is set, and refuses every call with `no_credentials`
 * rather than pretending (see `createCmsProviderFromEnv`).
 */
export type IntegrationDeps = Pick<CmsProviderDeps, "resolveSiteCredentials">;

function parseDownUrls(value: string | undefined): Set<string> {
  if (!value) return new Set<string>();
  return new Set(
    value
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0),
  );
}

/**
 * Every adapter, selected from the environment. Each factory is mock-first and
 * constructs only — nothing here opens a connection — so a wrong credential
 * fails on first use, not at boot. The one exception is a malformed
 * `COOLIFY_API_URL`, which `createHostingProviderFromEnv` refuses rather than
 * downgrading; `adapter-guard.ts` reports that as `UNBUILDABLE` before this
 * runs.
 */
export function createIntegrations(env: NodeJS.ProcessEnv, deps: IntegrationDeps = {}): Integrations {
  const uptime =
    env.UPTIME_PROBE === "http" ? new HttpUptimeProbe() : new MockUptimeProbe(parseDownUrls(env.MOCK_DOWN_URLS));
  return {
    uptime,
    hosting: createHostingProviderFromEnv(env),
    payments: createPaymentsAdapter(env),
    ads: createAdsAdapterFromEnv(env),
    dns: createDnsProvidersFromEnv(env),
    cms: createCmsProviderFromEnv(env, deps),
    social: createSocialPublisherFromEnv(env),
  };
}
