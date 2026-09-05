import type { CmsConnectionTest, CmsContentChange, CmsContentResult, CmsProvider } from "./index.js";
import { markdownToSafeHtml } from "./markdown.js";

/**
 * The real WordPress client: the REST API (`/wp-json/wp/v2`) authenticated with
 * an Application Password over HTTP Basic.
 *
 * Application Passwords rather than OAuth or a plugin because they are core
 * WordPress since 5.6, are issued per user per application, can be revoked from
 * the user's profile without changing their login, and need nothing installed on
 * the client's site. They are as powerful as the user they belong to, which is
 * why the credential is stored encrypted and per site, and why the tool that
 * calls this is approval-gated.
 *
 * Credentials arrive through `resolveSiteCredentials`, injected at construction.
 * `packages/integrations` is a leaf — it must not reach into the database or
 * `packages/core` for the encrypted row — so the caller closes over whatever it
 * needs and hands this class a function from a LaunchOS site id to a live
 * connection.
 */

export type WordPressErrorCode =
  /** No usable credential for this site — never configured, or no site id given. */
  | "no_credentials"
  /** The site row says it runs something other than WordPress. */
  | "not_wordpress"
  /** `primaryUrl` is not an http(s) URL we can build an API base from. */
  | "invalid_site_url"
  /** No page or post answers to that path. */
  | "page_not_found"
  /** WordPress rejected the application password (401/403). */
  | "auth_failed"
  /** Anything else the API returned, or a transport failure. */
  | "request_failed";

export class WordPressCmsError extends Error {
  readonly code: WordPressErrorCode;
  readonly status: number | undefined;
  constructor(code: WordPressErrorCode, message: string, status?: number) {
    super(message);
    this.name = "WordPressCmsError";
    this.code = code;
    this.status = status;
  }
}

/** Everything needed to talk to one client's WordPress, resolved per call. */
export interface WordPressSiteConnection {
  /** The site's `primaryUrl`; the API lives at `<baseUrl>/wp-json/wp/v2`. */
  readonly baseUrl: string;
  /** The site row's `platform`. Anything but `wordpress` is refused. */
  readonly platform: string;
  readonly username: string;
  readonly appPassword: string;
}

export type ResolveSiteCredentials = (siteId: string) => Promise<WordPressSiteConnection | null>;

export interface WordPressCmsOptions {
  readonly resolveSiteCredentials: ResolveSiteCredentials;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Enough of a WordPress error body to be diagnostic, not enough to fill a log. */
const MAX_ERROR_BODY = 300;

type PostType = "pages" | "posts";

interface Session {
  readonly apiBase: string;
  readonly authorization: string;
}

interface Target {
  readonly type: PostType;
  readonly id: number;
}

/** WordPress returns far more than this; only these fields are ever read. */
interface WpObject {
  readonly id?: number;
  readonly modified_gmt?: string;
  readonly modified?: string;
  readonly name?: string;
  readonly slug?: string;
}

export class WordPressCmsProvider implements CmsProvider {
  readonly name = "wordpress" as const;

  private readonly resolveSiteCredentials: ResolveSiteCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: WordPressCmsOptions) {
    this.resolveSiteCredentials = options.resolveSiteCredentials;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async updateContent(input: CmsContentChange): Promise<CmsContentResult> {
    const session = await this.open(input.siteId);
    const target = await this.findTarget(session, input.path);
    const content = markdownToSafeHtml(input.contentMd);

    const updated = await this.request<WpObject>(session, `${target.type}/${target.id}`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });

    return { revisionId: await this.latestRevisionId(session, target, updated), applied: true };
  }

  /**
   * `GET /wp-json/wp/v2/users/me` — the cheapest call that proves the base URL,
   * the username and the application password all line up.
   *
   * Returns the failure rather than throwing it: this is wired to a button in
   * the admin portal whose entire job is to report what is wrong.
   */
  async testConnection(input: { siteId: string }): Promise<CmsConnectionTest> {
    try {
      const session = await this.open(input.siteId);
      const me = await this.request<WpObject>(session, "users/me");
      return { ok: true, provider: this.name, identity: me.name ?? me.slug ?? String(me.id ?? "") };
    } catch (error) {
      return { ok: false, provider: this.name, message: messageOf(error) };
    }
  }

  private async open(siteId: string | undefined): Promise<Session> {
    if (!siteId) {
      throw new WordPressCmsError("no_credentials", "a WordPress update needs the LaunchOS site id, and none was given");
    }
    const connection = await this.resolveSiteCredentials(siteId);
    if (!connection) {
      throw new WordPressCmsError(
        "no_credentials",
        `site ${siteId} has no WordPress connection — add the username and application password on the website page`,
      );
    }
    if (connection.platform !== "wordpress") {
      throw new WordPressCmsError("not_wordpress", `site ${siteId} is recorded as ${connection.platform}, not wordpress`);
    }
    return { apiBase: apiBaseFor(connection.baseUrl), authorization: basicAuth(connection) };
  }

  /**
   * The page or post a path names.
   *
   * Pages first, then posts: an agency site's editable copy is nearly always a
   * page, and asking for posts first would match a blog entry that happens to
   * share a slug. An empty path is the front page, which WordPress records in
   * its settings rather than under any slug.
   */
  private async findTarget(session: Session, path: string): Promise<Target> {
    const slug = slugFromPath(path);
    if (!slug) return this.frontPage(session, path);

    for (const type of ["pages", "posts"] as const) {
      const found = await this.request<WpObject[]>(session, `${type}?slug=${encodeURIComponent(slug)}&per_page=5`);
      const match = Array.isArray(found) ? found.find((row) => typeof row.id === "number") : undefined;
      if (match) return { type, id: match.id! };
    }
    throw new WordPressCmsError("page_not_found", `no WordPress page or post has the slug "${slug}" (path ${path})`);
  }

  private async frontPage(session: Session, path: string): Promise<Target> {
    const settings = await this.request<{ page_on_front?: number }>(session, "settings");
    const id = Number(settings.page_on_front ?? 0);
    if (!Number.isInteger(id) || id <= 0) {
      throw new WordPressCmsError(
        "page_not_found",
        `${path} is the front page, and this site's front page is the blog index rather than an editable page`,
      );
    }
    return { type: "pages", id };
  }

  /**
   * The id of the revision the update just created.
   *
   * WordPress does not return it from the update itself, so it is read back from
   * the revisions collection. Best effort by design: some hosts disable
   * revisions entirely, and an update that succeeded must not be reported as a
   * failure because the receipt could not be fetched — the fallback names the
   * object and its modification stamp, which still locates the change in the
   * site's history.
   */
  private async latestRevisionId(session: Session, target: Target, updated: WpObject): Promise<string> {
    try {
      const revisions = await this.request<WpObject[]>(
        session,
        `${target.type}/${target.id}/revisions?per_page=1&orderby=id&order=desc`,
      );
      const newest = Array.isArray(revisions) ? revisions.find((row) => typeof row.id === "number") : undefined;
      if (newest) return String(newest.id);
    } catch {
      // Fall through to the stamp below.
    }
    return `${target.type}-${target.id}@${updated.modified_gmt ?? updated.modified ?? "unknown"}`;
  }

  private async request<T>(session: Session, path: string, init: { method?: string; body?: string } = {}): Promise<T> {
    const url = `${session.apiBase}/${path}`;
    const method = init.method ?? "GET";
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: session.authorization,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new WordPressCmsError("request_failed", `${method} ${url} failed: ${messageOf(error)}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new WordPressCmsError(
        "auth_failed",
        `WordPress rejected the application password (${response.status}). Check the username, and re-issue the ` +
          "application password from that user's WordPress profile.",
        response.status,
      );
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY);
      throw new WordPressCmsError(
        "request_failed",
        `${method} ${url} returned ${response.status}${body ? `: ${body}` : ""}`,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new WordPressCmsError("request_failed", `${url} did not return JSON: ${messageOf(error)}`, response.status);
    }
  }
}

/** `https://example.com/blog/` becomes `https://example.com/blog/wp-json/wp/v2`. */
function apiBaseFor(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WordPressCmsError("invalid_site_url", `"${baseUrl}" is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WordPressCmsError("invalid_site_url", `"${baseUrl}" is not an http(s) URL`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/wp-json/wp/v2`;
}

/**
 * Basic auth. WordPress issues application passwords in spaced groups
 * (`abcd EFGH ...`) and accepts them with or without the spaces, so whatever the
 * operator pasted is sent through unchanged.
 */
function basicAuth(connection: WordPressSiteConnection): string {
  return `Basic ${Buffer.from(`${connection.username}:${connection.appPassword}`, "utf8").toString("base64")}`;
}

/** The last non-empty path segment: `/services/seo/` resolves the slug `seo`. */
function slugFromPath(path: string): string {
  const segments = path.split(/[?#]/)[0]!.split("/").filter((segment) => segment.length > 0);
  const last = segments.at(-1) ?? "";
  try {
    return decodeURIComponent(last).trim();
  } catch {
    return last.trim();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
