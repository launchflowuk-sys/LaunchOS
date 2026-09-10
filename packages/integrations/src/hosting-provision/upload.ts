/**
 * Putting the generated pages onto the host.
 *
 * Hostinger's API creates websites and installs WordPress; it does not accept
 * files. Getting the pages onto the docroot is SFTP — the ordinary way of
 * copying files to a server — with credentials from the hosting panel.
 *
 * An interface with a mock, per rule 4, so the whole chain is testable and the
 * only thing waiting on credentials is the last few lines of the real one.
 */

export interface UploadFile {
  /** Relative to the docroot: `index.html`, `style.css`, `services/index.html`. */
  path: string;
  contents: string;
}

export interface SiteUploader {
  readonly name: "sftp" | "mock";
  readonly live: boolean;
  /** Writes every file under `rootDirectory`, creating folders as needed. */
  upload(rootDirectory: string, files: readonly UploadFile[]): Promise<void>;
}

/**
 * Remembers what it was given and writes nothing.
 *
 * Deliberately not a no-op: tests assert on what would have been written, which
 * is what catches a generated site arriving empty — the failure that would
 * otherwise only show up as a blank page a client had already been sent.
 */
export class MockSiteUploader implements SiteUploader {
  readonly name = "mock" as const;
  readonly live = false;

  readonly written = new Map<string, UploadFile[]>();

  async upload(rootDirectory: string, files: readonly UploadFile[]): Promise<void> {
    if (files.length === 0) throw new Error("nothing to upload: the generated site had no files");
    this.written.set(rootDirectory, [...files]);
  }
}

/** The generated site as files a host can hold. */
export function filesFromGeneratedSite(site: {
  pages: readonly { path: string; title: string; html: string }[];
  css: string;
}): UploadFile[] {
  const files: UploadFile[] = site.pages.map((page) => ({
    // `/` becomes `index.html`; `/services` becomes `services/index.html`, so
    // every page has a real URL without the server needing rewrite rules.
    path: page.path === "/" ? "index.html" : `${page.path.replace(/^\/+|\/+$/g, "")}/index.html`,
    contents: [
      "<!doctype html>",
      '<html lang="en-GB">',
      "<head>",
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      `<title>${escapeHtml(page.title)}</title>`,
      '<link rel="stylesheet" href="/style.css" />',
      "</head>",
      "<body>",
      page.html,
      "</body>",
      "</html>",
    ].join("\n"),
  }));

  if (site.css.trim().length > 0) files.push({ path: "style.css", contents: site.css });
  return files;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
