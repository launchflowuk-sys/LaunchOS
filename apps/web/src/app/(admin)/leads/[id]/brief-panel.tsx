import { CircleDashed, Download, FileText, Sparkles } from "lucide-react";
import type { LeadBrief, LeadDraftProgress } from "@launchos/core";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";

/**
 * The website brief, on the lead it belongs to.
 *
 * Two states worth telling apart, and the screen says which out loud:
 *
 * - **Sent.** There is a reference and a brief. Whether a model has been over
 *   it yet is stated rather than implied — a plain brief and a written one are
 *   both legitimate, but presenting them identically is how nobody notices the
 *   AI has been failing for a week.
 * - **Still filling it in.** A draft with a step number and a last-seen time.
 *   Knowing somebody reached stage six and went quiet is the difference between
 *   a cold call and a useful one.
 */
export function BriefPanel({ brief, draft }: { brief: LeadBrief | null; draft: LeadDraftProgress | null }) {
  if (brief) {
    return (
      <Section
        title="Website brief"
        description={`Reference ${brief.reference} · sent ${formatDateTime(brief.submittedAt)}`}
      >
        <div className="rounded-[20px] border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
            <p className="flex items-center gap-2 text-meta text-muted-foreground">
              {brief.awaitingWriter ? (
                <>
                  <CircleDashed aria-hidden className="size-4" />
                  Written from their answers. The brief writer has not been over it yet.
                </>
              ) : (
                <>
                  <Sparkles aria-hidden className="size-4" />
                  Version {brief.version}
                  {brief.model ? ` · ${brief.model}` : null}
                </>
              )}
            </p>
            <a
              href={`/api/brief-funnel/export?submission=${brief.submissionId}&format=md`}
              className="inline-flex items-center gap-1.5 text-meta font-medium text-primary hover:underline"
            >
              <Download aria-hidden className="size-3.5" />
              Download Markdown
            </a>
          </div>

          {/* Rendered as pre-wrapped text, not parsed as Markdown. It is model
              output and customer prose; the one place it must not become
              markup is a staff screen that also shows other people's data. */}
          <pre className="max-h-[560px] overflow-auto px-5 py-4 text-sm leading-relaxed break-words whitespace-pre-wrap">
            {brief.markdown}
          </pre>
        </div>
      </Section>
    );
  }

  if (draft) {
    return (
      <Section title="Website brief" description="Started, not sent.">
        <div className="rounded-[20px] border bg-card p-5">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge value={`step ${draft.currentStep} of 8`} />
            <p className="text-meta text-muted-foreground">
              Last touched {formatDateTime(draft.lastActivityAt)} · {draft.completedSteps.length} of 8 finished
            </p>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            They are part-way through the questionnaire. Everything they have entered so far is saved — they
            can pick it up where they left off.
          </p>
        </div>
      </Section>
    );
  }

  return (
    <Section title="Website brief" description="Nothing yet.">
      <div className="rounded-[20px] border bg-card p-5">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText aria-hidden className="size-4" />
          This lead did not come through the brief questionnaire.
        </p>
      </div>
    </Section>
  );
}
