/**
 * The document itself, as the client will read it.
 *
 * It is the same HTML the worker hands to Chromium — `proposalDocumentHtml`
 * from core — so what is on this screen is the PDF, not a second rendering of
 * the same facts that could drift from it. The web app cannot make the PDF
 * (Chromium lives in the worker), but it can show the page that becomes one,
 * and that is the half worth seeing before pressing Send.
 *
 * `srcDoc` rather than a URL, so no route has to exist to serve a draft, and
 * `sandbox=""` — no scripts, no forms, no same-origin — because the body
 * carries a client's typed company name and a summary an agent drafted. Core
 * escapes every one of those already; this is the second lock on the same door.
 */
export function DocumentPreview({ html, title }: { html: string; title: string }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <iframe
        title={title}
        srcDoc={html}
        sandbox=""
        // A4 is taller than it is wide, so the preview is given a page's worth
        // of height and scrolls inside its own box rather than pushing the
        // editor beside it down the screen.
        className="h-[60vh] w-full border-0 bg-white lg:h-[calc(100vh-13rem)]"
      />
    </div>
  );
}
