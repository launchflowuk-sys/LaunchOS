/**
 * Which engine this process renders documents with, and the one process-wide
 * browser it does it through.
 *
 * Selection follows the same shape as `createEmailAdapter` and
 * `createPushAdapterFromEnv`: mock unless the environment says otherwise. It
 * differs in one respect, and deliberately — the default here is *real*, and
 * the mock is chosen only under `NODE_ENV=test` or an explicit
 * `PDF_RENDERER=mock`. The mock-first rule exists so that an unconfigured
 * developer does not accidentally send live email; a PDF engine sends nothing,
 * needs no credentials, and its mock produces a document that is valid but
 * empty. Defaulting *that* to on would mean a worker quietly mailing clients a
 * blank proposal, so the failure mode is inverted: render for real, and let a
 * missing browser be a loud error.
 *
 * `apps/worker/src/env.ts` refuses `PDF_RENDERER=mock` under
 * `NODE_ENV=production` for the other half of the same reason.
 */
import { ChromiumPdfRenderer, chromiumOptionsFromEnv } from "./chromium.js";
import { MockPdfRenderer } from "./mock.js";
import type { PdfRenderer, RenderPdfInput } from "./types.js";

/** The one variable that overrides the default. `mock` or `chromium`. */
export const PDF_RENDERER_ENV = "PDF_RENDERER";

/** Which renderer this environment describes, without building it. */
export function pdfRendererKind(env: NodeJS.ProcessEnv = process.env): PdfRenderer["kind"] {
  const explicit = env[PDF_RENDERER_ENV]?.trim();
  if (explicit === "mock") return "mock";
  if (explicit === "chromium") return "chromium";
  return env.NODE_ENV === "test" ? "mock" : "chromium";
}

export function createPdfRenderer(env: NodeJS.ProcessEnv = process.env): PdfRenderer {
  return pdfRendererKind(env) === "mock" ? new MockPdfRenderer() : new ChromiumPdfRenderer(chromiumOptionsFromEnv(env));
}

/**
 * The process's renderer. Built on first use, never rebuilt.
 *
 * Module state rather than something threaded through every caller because
 * the browser it wraps is a genuine process singleton — two of them is two
 * Chromiums — and because the alternative is passing a renderer through every
 * job handler that will ever produce a document.
 */
let shared: PdfRenderer | null = null;

export function pdfRenderer(env: NodeJS.ProcessEnv = process.env): PdfRenderer {
  shared ??= createPdfRenderer(env);
  return shared;
}

/**
 * `renderPdf({ html, format, margin })` → the bytes.
 *
 * The only entry point a document type should need. It borrows the shared
 * renderer; a render never launches a browser of its own.
 */
export function renderPdf(input: RenderPdfInput, env: NodeJS.ProcessEnv = process.env): Promise<Uint8Array<ArrayBuffer>> {
  return pdfRenderer(env).render(input);
}

/**
 * Shuts the shared browser down and forgets it. Called on worker shutdown, and
 * by any test that rendered for real. Idempotent.
 */
export async function closePdfRenderer(): Promise<void> {
  const renderer = shared;
  shared = null;
  await renderer?.close();
}
