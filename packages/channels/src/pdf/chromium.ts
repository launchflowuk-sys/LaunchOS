/**
 * The real engine: one headless Chromium, launched on the first document and
 * kept for the life of the process.
 *
 * A browser launch costs about a second and 120 MB. A worker that launched one
 * per document would spend more time starting Chromium than rendering, and a
 * month-end run that renders forty invoices would start forty of them — so the
 * browser is a process-wide resource, `render` only ever borrows a page from
 * it, and `close()` on shutdown is what stops a container leaking one.
 *
 * Three decisions worth the ink:
 *
 * - **`--no-sandbox`.** Chromium's own sandbox needs either a setuid helper or
 *   `CAP_SYS_ADMIN`, and has neither as PID 1 in a container. The usual reason
 *   to fight for it is that the browser will load somebody else's page; this
 *   one never does. It renders HTML this codebase generated, with every value
 *   escaped by `renderDocumentHtml`, and `RenderPdfInput` forbids fetching
 *   anything. The container is the sandbox.
 * - **`--disable-dev-shm-usage`.** Docker gives `/dev/shm` 64 MB by default;
 *   Chromium uses it for its renderer's shared memory and crashes with
 *   `Target closed` part-way through a long document when it runs out. The
 *   flag moves that to `/tmp`. This is the single most common cause of a PDF
 *   engine that works on a laptop and fails in production.
 * - **`executablePath` from the environment.** In the image the browser comes
 *   from the distribution (`apk add chromium`), not from Playwright's own
 *   download, so the path is told to us rather than looked up. Unset — a
 *   developer's machine — Playwright resolves the chromium it installed for
 *   the e2e suite, and nothing needs configuring.
 */
import type { Browser } from "playwright";
import { DOCUMENT_MARGIN, EMPTY_HEADER_TEMPLATE, documentFooterTemplate } from "./document.js";
import { PdfRenderFailed, looksLikePdf, type PdfRenderer, type RenderPdfInput } from "./types.js";

/**
 * Where the browser binary lives. Named by the P3 spec and read here rather
 * than by Playwright, which has no such variable of its own — its only native
 * lever is `PLAYWRIGHT_BROWSERS_PATH`, which points at a download layout the
 * distribution's `/usr/bin/chromium-browser` does not have.
 */
export const CHROMIUM_PATH_ENV = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";

/** A document has to be laid out and printed inside this, or the render fails. */
export const RENDER_TIMEOUT_MS = 30_000;

const LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"];

export interface ChromiumPdfRendererOptions {
  executablePath?: string | undefined;
  timeoutMs?: number;
}

export function chromiumOptionsFromEnv(env: NodeJS.ProcessEnv): ChromiumPdfRendererOptions {
  // Blank is unset, the same rule as `createEmailAdapter` and the worker's env
  // parser: a Coolify variable created and left empty arrives as `""`, and
  // handing that to Playwright as an executable path fails with ENOENT on "".
  const path = env[CHROMIUM_PATH_ENV]?.trim();
  return { executablePath: path ? path : undefined };
}

export class ChromiumPdfRenderer implements PdfRenderer {
  readonly kind = "chromium" as const;
  private browser: Browser | null = null;
  /** The in-flight launch, so two concurrent first renders share one browser. */
  private launching: Promise<Browser> | null = null;

  constructor(private readonly options: ChromiumPdfRendererOptions = {}) {}

  /**
   * The shared browser, launched if it is not up yet.
   *
   * `isConnected()` rather than a bare null check: a Chromium that ran out of
   * memory leaves this object holding a dead handle, and every later render
   * would throw `Target page, context or browser has been closed` until the
   * worker restarted. Treating a disconnected browser as no browser turns that
   * into one slow render instead of an outage.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = null;
    if (!this.launching) {
      // Imported here, not at the top of the file: `playwright` pulls its
      // driver in on load, and a process that only ever uses the mock (every
      // test, and the web app, which imports this package for its email
      // templates) should not pay for that.
      this.launching = import("playwright")
        .then(({ chromium }) =>
          chromium.launch({
            args: LAUNCH_ARGS,
            ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
          }),
        )
        .then((browser) => {
          this.browser = browser;
          return browser;
        })
        .catch((error: unknown) => {
          throw new PdfRenderFailed(
            `could not start Chromium — set ${CHROMIUM_PATH_ENV} to the browser binary, or install one with \`pnpm exec playwright install chromium\``,
            { cause: error },
          );
        })
        .finally(() => {
          this.launching = null;
        });
    }
    return this.launching;
  }

  async render(input: RenderPdfInput): Promise<Uint8Array<ArrayBuffer>> {
    const browser = await this.ensureBrowser();
    const timeout = this.options.timeoutMs ?? RENDER_TIMEOUT_MS;
    const page = await browser.newPage();
    try {
      // `domcontentloaded`, not `load`: a document is forbidden from fetching
      // anything (see `RenderPdfInput`), so there is nothing for `load` to wait
      // for — and if a caller ever breaks that rule, waiting would hang the
      // worker for the timeout rather than printing without the asset.
      await page.setContent(input.html, { waitUntil: "domcontentloaded", timeout });
      // Print media, so `@page` and any `@media print` rule in the body apply.
      await page.emulateMedia({ media: "print" });
      const footer = input.displayFooter !== false;
      const bytes = await page.pdf({
        format: input.format ?? "A4",
        margin: { ...DOCUMENT_MARGIN, ...input.margin },
        printBackground: true,
        preferCSSPageSize: false,
        displayHeaderFooter: footer,
        ...(footer
          ? { headerTemplate: EMPTY_HEADER_TEMPLATE, footerTemplate: documentFooterTemplate(input.footerReference) }
          : {}),
      });
      // `Uint8Array.from`, not `new Uint8Array(buffer)`: the latter keeps the
      // Buffer's own `ArrayBufferLike` and would not satisfy the interface.
      const out = Uint8Array.from(bytes);
      // Chromium has been known to answer an empty buffer rather than an error
      // when its renderer died mid-print. Refusing here means the caller never
      // stores a zero-byte "document" a client would later be sent.
      if (!looksLikePdf(out)) throw new PdfRenderFailed("Chromium returned bytes that are not a PDF");
      return out;
    } finally {
      // The page goes even when the render threw; the browser stays.
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const browser = this.browser ?? (this.launching ? await this.launching.catch(() => null) : null);
    this.browser = null;
    await browser?.close().catch(() => {});
  }
}
