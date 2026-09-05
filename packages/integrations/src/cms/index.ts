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

export type CmsPostStatus = "publish" | "draft";

/** A new blog post, written by the content engine and approved by a human. */
export interface CmsCreatePostInput {
  /** The LaunchOS site id; credentials are held per site. */
  readonly siteId: string;
  readonly title: string;
  /** The same markdown subset `updateContent` takes — see `markdownToSafeHtml`. */
  readonly contentMarkdown: string;
  readonly status: CmsPostStatus;
  readonly excerpt?: string | undefined;
  /** Category *names*; resolved to ids, created when missing, skipped with a note when neither is allowed. */
  readonly categories?: readonly string[] | undefined;
  /** A publicly fetchable image, sideloaded into the media library. Best effort — see `note`. */
  readonly featuredImageUrl?: string | undefined;
}

export interface CmsCreatePostResult {
  /** The WordPress post id. */
  readonly externalId: string;
  /** The post's `link` — the public URL for a published post, a preview URL for a draft. */
  readonly url: string;
  readonly status: CmsPostStatus;
  /** Anything that did not go to plan without stopping the post: a skipped image or category, in words. */
  readonly note?: string | undefined;
}

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
  createPost(input: CmsCreatePostInput): Promise<CmsCreatePostResult>;
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
  readonly posts: CmsCreatePostInput[] = [];
  async updateContent(input: CmsContentChange): Promise<CmsContentResult> {
    this.changes.push(input);
    return { revisionId: `mock-cms-${this.changes.length}`, applied: true };
  }
  async createPost(input: CmsCreatePostInput): Promise<CmsCreatePostResult> {
    this.posts.push(input);
    const n = this.posts.length;
    return { externalId: `mock-post-${n}`, url: `https://mock-cms.local/?p=${n}`, status: input.status };
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
   *
   * Optional so `createIntegrations(env)` can be called without one (the agent
   * catalogue and the tests do). Without it the real provider is still built
   * when the key is set, and every call on it fails with `no_credentials`
   * rather than the mock's cheerful success — see `unreachableCredentials`.
   */
  readonly resolveSiteCredentials?: ResolveSiteCredentials | undefined;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The resolver a process gets when it has the encryption key but handed over
 * no way to read credentials. Every lookup answers "no connection", so the
 * provider throws `no_credentials` on the first call: loud, and named after the
 * real gap. The alternative — falling back to the mock — would report the page
 * updated while touching nothing, which is the one outcome this package exists
 * to avoid.
 */
const unreachableCredentials: ResolveSiteCredentials = async () => null;

/**
 * The real WordPress provider when secrets can be decrypted, the mock otherwise.
 *
 * There is deliberately no `CMS_ADAPTER` variable: which sites are actually
 * reachable is decided per call by whether that site has a credential row, not
 * by one global switch. `SECRETS_ENCRYPTION_KEY` is the honest gate, because
 * without it not a single credential can be read. A blank key is an unset one,
 * matching every other factory here.
 *
 * Never throws: a key that is set but not 32 bytes of base64 is rejected by
 * `packages/core`'s `SecretsKeyError` at the first read or write, with the
 * problem named, not here.
 */
export function createCmsProviderFromEnv(env: NodeJS.ProcessEnv, deps: CmsProviderDeps = {}): CmsProvider {
  if (!env.SECRETS_ENCRYPTION_KEY?.trim()) return new MockCmsProvider();
  return new WordPressCmsProvider({
    resolveSiteCredentials: deps.resolveSiteCredentials ?? unreachableCredentials,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

export * from "./wordpress.js";
export { markdownToSafeHtml } from "./markdown.js";
export type { WordPressPostClient, WordPressRequestInit } from "./create-post.js";
