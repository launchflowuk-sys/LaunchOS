import type { CmsCreatePostInput, CmsCreatePostResult } from "./index.js";
import { markdownToSafeHtml } from "./markdown.js";
import { WordPressCmsError } from "./wordpress.js";

/**
 * `POST /wp-json/wp/v2/posts` for the content engine's blog posts, plus the two
 * best-effort extras around it.
 *
 * The post itself is the one call that must succeed. Categories and the
 * featured image are *decoration*: a client's site may have an author-level
 * application password that cannot create categories or upload media, and a
 * blog post published without its picture is a far better outcome than a post
 * that was approved, scheduled and then never went out. Each extra therefore
 * catches its own failure, drops it into `note`, and lets the post go.
 */

/** The slice of `WordPressCmsProvider` this needs: one authenticated request path, and a bare fetch for the image. */
export interface WordPressPostClient {
  request<T>(path: string, init?: WordPressRequestInit): Promise<T>;
  /** Unauthenticated, for fetching the featured image from wherever it is hosted. */
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export interface WordPressRequestInit {
  readonly method?: string;
  /** JSON as a string, or the raw bytes of a media upload. `<ArrayBuffer>` because that is what `lib.dom`'s `BodyInit` accepts. */
  readonly body?: string | Uint8Array<ArrayBuffer>;
  readonly headers?: Record<string, string>;
}

/** WordPress's `image_size_limit` defaults are larger, but a blog hero has no business being bigger than this. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const EXTENSION_FOR: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
};

interface WpTerm {
  readonly id?: number;
  readonly name?: string;
}

interface WpPost {
  readonly id?: number;
  readonly link?: string;
  readonly status?: string;
}

interface Prepared {
  readonly categories: number[];
  readonly featuredMedia: number | undefined;
  readonly notes: string[];
}

export async function createWordPressPost(client: WordPressPostClient, input: CmsCreatePostInput): Promise<CmsCreatePostResult> {
  const prepared = await prepare(client, input);
  const created = await client.request<WpPost>("posts", {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      content: markdownToSafeHtml(input.contentMarkdown),
      status: input.status,
      ...(input.excerpt ? { excerpt: input.excerpt } : {}),
      ...(prepared.categories.length > 0 ? { categories: prepared.categories } : {}),
      ...(prepared.featuredMedia === undefined ? {} : { featured_media: prepared.featuredMedia }),
    }),
  });
  if (typeof created.id !== "number") {
    throw new WordPressCmsError("request_failed", "WordPress created the post but returned no id");
  }
  const status = created.status === "publish" ? "publish" : "draft";
  return {
    externalId: String(created.id),
    url: created.link ?? "",
    status,
    ...(prepared.notes.length > 0 ? { note: prepared.notes.join(" ") } : {}),
  };
}

/** Categories resolved to ids and the image uploaded, each with its failure noted rather than thrown. */
async function prepare(client: WordPressPostClient, input: CmsCreatePostInput): Promise<Prepared> {
  const notes: string[] = [];
  const categories: number[] = [];
  for (const name of input.categories ?? []) {
    try {
      categories.push(await categoryId(client, name));
    } catch (error) {
      notes.push(`Category "${name}" was skipped: ${messageOf(error)}`);
    }
  }
  let featuredMedia: number | undefined;
  if (input.featuredImageUrl) {
    try {
      featuredMedia = await sideloadImage(client, input.featuredImageUrl);
    } catch (error) {
      notes.push(`Featured image was skipped: ${messageOf(error)}`);
    }
  }
  return { categories, featuredMedia, notes };
}

/**
 * The id of the category with this name, created if there is none. The search
 * is a substring match on WordPress's side, so the exact name is picked out of
 * whatever comes back; WordPress HTML-encodes `&` in term names, which is the
 * one entity a business category ("Taxis & Transfers") is likely to hit.
 */
async function categoryId(client: WordPressPostClient, name: string): Promise<number> {
  const wanted = name.trim().toLowerCase();
  const found = await client.request<WpTerm[]>(`categories?search=${encodeURIComponent(name.trim())}&per_page=20`);
  const match = Array.isArray(found)
    ? found.find((term) => typeof term.id === "number" && (term.name ?? "").replace(/&amp;/g, "&").trim().toLowerCase() === wanted)
    : undefined;
  if (match) return match.id!;
  const created = await client.request<WpTerm>("categories", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
  if (typeof created.id !== "number") throw new WordPressCmsError("request_failed", "WordPress returned no id for the new category");
  return created.id;
}

/**
 * "Sideload": the REST API has no fetch-by-URL endpoint, so the bytes are
 * fetched here and uploaded as the body of `POST /media` with a
 * `Content-Disposition` filename — the documented raw-upload form, which needs
 * no multipart encoding. The fetch is unauthenticated and http(s)-only, and is
 * capped, because the URL is whatever the approved content item carries.
 */
async function sideloadImage(client: WordPressPostClient, imageUrl: string): Promise<number> {
  const { bytes, mime, filename } = await fetchImage(client, imageUrl);
  const media = await client.request<WpTerm>("media", {
    method: "POST",
    body: bytes,
    headers: { "content-type": mime, "content-disposition": `attachment; filename="${filename}"` },
  });
  if (typeof media.id !== "number") throw new WordPressCmsError("request_failed", "WordPress returned no id for the uploaded image");
  return media.id;
}

async function fetchImage(
  client: WordPressPostClient, imageUrl: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; filename: string }> {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    throw new WordPressCmsError("request_failed", `"${imageUrl}" is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WordPressCmsError("request_failed", `"${imageUrl}" is not an http(s) URL`);
  }
  let response: Response;
  try {
    response = await client.fetchImpl(url.href, { method: "GET", signal: AbortSignal.timeout(client.timeoutMs) });
  } catch (error) {
    throw new WordPressCmsError("request_failed", `fetching ${url.href} failed: ${messageOf(error)}`);
  }
  if (!response.ok) throw new WordPressCmsError("request_failed", `fetching ${url.href} returned ${response.status}`, response.status);
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!mime.startsWith("image/")) throw new WordPressCmsError("request_failed", `${url.href} is ${mime || "of unknown type"}, not an image`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) throw new WordPressCmsError("request_failed", `${url.href} is ${declared} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new WordPressCmsError("request_failed", `${url.href} is ${bytes.byteLength} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  if (bytes.byteLength === 0) throw new WordPressCmsError("request_failed", `${url.href} is empty`);
  return { bytes, mime, filename: filenameFor(url, mime) };
}

/** The URL's last segment when it looks like a filename, else `featured.<ext>`; either way only safe characters. */
function filenameFor(url: URL, mime: string): string {
  const extension = EXTENSION_FOR[mime] ?? (mime.slice("image/".length).replace(/[^a-z0-9]/g, "") || "img");
  const last = url.pathname.split("/").filter((segment) => segment.length > 0).at(-1) ?? "";
  const safe = last.replace(/[^\w.-]/g, "").replace(/^\.+/, "");
  if (safe.length > 0 && safe.includes(".")) return safe.slice(0, 120);
  return `featured.${extension}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
