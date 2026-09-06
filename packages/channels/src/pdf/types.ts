/**
 * The one shape every document renderer answers to.
 *
 * Deliberately narrow: HTML in, bytes out. Nothing here knows what a proposal
 * is, and nothing here reaches a database — a renderer is a peripheral, like
 * the SMTP transport next door, and is swapped for a mock the same way.
 */

/** The paper a LaunchFlow document is set on. A4 unless somebody asks for US Letter. */
export type PdfPageFormat = "A4" | "Letter";

/** CSS lengths (`18mm`, `0.75in`). Chromium reads them as printed margins. */
export interface PdfMargin {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

export interface RenderPdfInput {
  /**
   * A complete HTML document. **Nothing in it may be fetched over the
   * network**: no `<img src="https://…">`, no web font, no stylesheet link. A
   * document is evidence a client keeps for years and a renderer that reaches
   * the internet produces a different file on a bad day than on a good one —
   * and blocks the browser while it tries. `renderDocumentHtml` obeys this;
   * anything else handed in here must too.
   */
  html: string;
  format?: PdfPageFormat;
  margin?: PdfMargin;
  /**
   * The reference printed bottom-left on every page, beside "Page 1 of 3".
   * Omitted, the footer carries the page numbers alone.
   */
  footerReference?: string;
  /** Off for a body that supplies its own headed sheet on page one. */
  displayFooter?: boolean;
}

export interface PdfRenderer {
  /** `"chromium"` or `"mock"` — printed in the worker's startup line. */
  readonly kind: "chromium" | "mock";
  /**
   * `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`, all the way down this
   * chain. A `Buffer` is a `Uint8Array<ArrayBufferLike>` and TypeScript will
   * not narrow it back, so a renderer that returned one could not be handed to
   * `storeDocument` — whose Zod schema infers the owned-buffer form — without
   * a copy at every call site. Copying once, here, keeps every caller honest.
   */
  render(input: RenderPdfInput): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Shuts the browser down. Idempotent, and safe to call on a renderer that
   * never launched one — the worker calls it on every SIGTERM, including the
   * ones that arrive before a single document was asked for.
   */
  close(): Promise<void>;
}

/** The engine produced something that is not a PDF, or produced nothing. */
export class PdfRenderFailed extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfRenderFailed";
  }
}

/** Every PDF starts `%PDF-`. Cheap proof that bytes are what they claim to be. */
export const PDF_MAGIC = "%PDF-";

export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}
