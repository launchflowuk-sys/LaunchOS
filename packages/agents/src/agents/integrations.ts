import { siteCredentialResolver } from "@launchos/core";
import type { Db } from "@launchos/db";
import { createCmsProviderFromEnv, type CmsProvider, type Integrations } from "@launchos/integrations";

/**
 * What a CMS provider needs to know before it can reach a site's credentials:
 * whose site it is. The tool context carries both.
 */
export interface CmsProviderScope {
  readonly db: Db;
  readonly organisationId: string;
}

/**
 * A CMS provider built per organisation, at tool-call time.
 *
 * The real WordPress provider reads each site's application password through
 * `siteCredentialResolver(db, organisationId)`, which is bound to one tenant —
 * and neither process that builds the agent registry has a tenant at startup:
 * the worker serves every organisation from one registry, and the web app's
 * agent catalogue has no database in hand at all. So the registry carries a
 * factory, and `cms_update_content` calls it with the run's own organisation.
 */
export type CmsProviderFactory = (scope: CmsProviderScope) => CmsProvider;

/**
 * The slice of `Integrations` the shipped agents actually consume. Narrowing to
 * a `Pick` keeps `packages/agents` decoupled from members added for other
 * plans (payments, ads), which would otherwise force every caller and test
 * fixture to construct adapters no agent uses. `dns` and `cms` back the
 * Support Triage agent's approval-gated tools.
 *
 * `cms` is either a provider — the tests hand in a `MockCmsProvider` — or a
 * `CmsProviderFactory`, which is what production wires (see `scopedCmsProvider`).
 */
export type AgentIntegrations = Pick<Integrations, "uptime" | "hosting" | "dns"> & {
  cms: CmsProvider | CmsProviderFactory;
};

/**
 * The provider a tool should use, given what it was constructed with.
 * A plain provider is returned as it is; a factory is called with the scope.
 */
export function cmsProviderFor(cms: CmsProvider | CmsProviderFactory, scope: CmsProviderScope): CmsProvider {
  return typeof cms === "function" ? cms(scope) : cms;
}

/**
 * The production `cms` entry: `createCmsProviderFromEnv` with a credential
 * resolver bound to the organisation of whichever run is calling. When
 * `SECRETS_ENCRYPTION_KEY` is unset this is the mock for every organisation,
 * exactly as `createIntegrations(env).cms` would be.
 *
 * The resolver returns `null` for a site outside the organisation, so an
 * approved change can only ever reach a site the run's own tenant owns.
 */
export function scopedCmsProvider(env: NodeJS.ProcessEnv): CmsProviderFactory {
  return ({ db, organisationId }) =>
    createCmsProviderFromEnv(env, { resolveSiteCredentials: siteCredentialResolver(db, organisationId, env) });
}
