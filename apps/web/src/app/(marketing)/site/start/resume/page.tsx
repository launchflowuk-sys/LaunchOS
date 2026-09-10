import type { Metadata } from "next";
import { ResumePanel } from "./resume-panel";

export const metadata: Metadata = {
  title: "Carry on with your brief",
  // A link with a token in it has no business in a search index, and the
  // referrer must not carry the token to anywhere else either.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The landing page for a resume link.
 *
 * It shows a button and nothing else happens until that button is pressed.
 * Mail scanners and link previewers fetch every URL in a message before the
 * person does, so consuming the token on load would mean Outlook spending it
 * and the customer getting an "already used" page they cannot explain.
 */
export default function ResumePage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[#F5F6F8] px-5 py-16">
      <ResumePanel />
    </main>
  );
}
