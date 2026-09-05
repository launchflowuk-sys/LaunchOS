import { WordPressCmsProvider, type ResolveSiteCredentials } from "./wordpress.js";

export interface CmsContentChange {
  /** The hosting reference recorded on the site row. */
  siteRef: string;
  /**
   * The LaunchOS site id. Optional so the mock and its callers keep working
   * without one; the real provider refuses without it, because credentials are
   * held per site and there is nothing else to look them up by.
   */
  siteId?: string;
  path: string;
  contentMd: string;
}
export interface CmsContentResult { revisionId: string; applied: boolean }

/** What a "test this connection" button gets back. Never throws for a failure. */
export interface CmsConnectionTest {
  ok: boolean;
  provider: string;
  /** Who the credential authenticates as, when it authenticates. */
  identity?: string | undefined;
  /** Why it did not, in words an operator can act on. */
  message?: string | undefined;
}

export interface CmsProvider {
  readonly name: "mock-cms" | "wordpress";
  updateContent(input: CmsContentChange): Promise<CmsContentResult>;
  testConnection(input: { siteId: string }): Promise<CmsConnectionTest>;
}

/**
 * Records what it was asked to change and reports success. Selected whenever no
 * `SECRETS_ENCRYPTION_KEY` is configured, because without it the per-site
 * application passwords cannot be stored or read at all.
 */
export class MockCmsProvider implements CmsProvider {
  readonly name = "mock-cms" as const;
  readonly changes: CmsContentChange[] = [];
  async updateContent(input: CmsContentChange): Promise<CmsContentResult> {
    this.changes.push(input);
    return { revisionId: `mock-cms-${this.changes.length}`, applied: true };
  }
  async testConnection(): Promise<CmsConnectionTest> {
    return {
      ok: false,
      provider: this.name,
      message: "No CMS credentials are configured: SECRETS_ENCRYPTION_KEY is unset, so LaunchOS is using the mock CMS.",
    };
  }
}

export interface CmsProviderDeps {
  /**
   * Site id to live WordPress connection. Supplied by the caller — `apps/web`
   * and `apps/worker` both have a database handle and the decryption key;
   * `packages/integrations` has neither and must stay a leaf.
   */
  readonly resolveSiteCredentials: ResolveSiteCredentials;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The real WordPress provider when secrets can be decrypted, the mock otherwise.
 *
 * There is deliberately no `CMS_ADAPTER` variable: which sites are actually
 * reachable is decided per call by whether that site has a credential row, not
 * by one global switch. `SECRETS_ENCRYPTION_KEY` is the honest gate, because
 * without it not a single credential can be read.
 */
export function createCmsProviderFromEnv(env: NodeJS.ProcessEnv, deps: CmsProviderDeps): CmsProvider {
  if (!env.SECRETS_ENCRYPTION_KEY?.trim()) return new MockCmsProvider();
  return new WordPressCmsProvider({
    resolveSiteCredentials: deps.resolveSiteCredentials,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

export * from "./wordpress.js";
export { markdownToSafeHtml } from "./markdown.js";
