/**
 * A PDF renderer that never launches a browser.
 *
 * Every test and every CI run uses this one, and that is the point: a suite
 * that spawns Chromium is a suite that fails on a machine with no browser, on
 * a container with no shared memory, and at three in the morning for reasons
 * nobody can reproduce. `createPdfRenderer` selects it automatically under
 * `NODE_ENV=test`, so a test has to go out of its way to render for real.
 *
 * What it returns is a *genuinely valid* single-page PDF rather than a string
 * of bytes with the right first five characters. That matters because
 * `storeDocument` checks the magic number, an assertion may open the file, and
 * a mock that produced something a reader rejects would push the discovery of
 * a real bug into production. The document's title is drawn on the page, so a
 * test can also prove the right document reached the renderer.
 */
import type { PdfRenderer, RenderPdfInput } from "./types.js";

/** Everything a PDF string literal may not contain unescaped. */
function pdfText(value: string): string {
  return value.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, " ").slice(0, 120);
}

/** The `<title>` of an HTML document, for the line the mock page draws. */
export function titleOf(html: string): string {
  return /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "LaunchFlow document";
}

/**
 * One A4 page carrying `line`, assembled by hand.
 *
 * Written out rather than pulled from a library because the whole job is 40
 * lines of a format that has not changed since 1993, and a dependency whose
 * only consumer is the test path is a dependency in the production image for
 * nothing. The cross-reference table has to carry each object's real byte
 * offset, so the objects are laid out first and measured as they go — get an
 * offset wrong and every reader refuses the file, which is exactly what the
 * accompanying test checks by parsing it back.
 */
export function tinyPdf(line: string): Uint8Array<ArrayBuffer> {
  const content = `BT /F1 14 Tf 56 780 Td (${pdfText(line)}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startXref = pdf.length;
  // Entry 0 is the head of the free list and is fixed by the specification.
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  // One byte per character, by hand: every offset in the table above was
  // counted in characters, and only a single-byte encoding keeps those counts
  // true. `pdfText` has already reduced the one caller-supplied string to
  // printable ASCII, so nothing here can exceed a byte.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

export class MockPdfRenderer implements PdfRenderer {
  readonly kind = "mock" as const;
  /** Every render, in order — what a test asserts on instead of parsing bytes. */
  readonly rendered: RenderPdfInput[] = [];

  async render(input: RenderPdfInput): Promise<Uint8Array<ArrayBuffer>> {
    this.rendered.push(input);
    const reference = input.footerReference ? ` (${input.footerReference})` : "";
    return tinyPdf(`${titleOf(input.html)}${reference}`);
  }

  async close(): Promise<void> {}
}
