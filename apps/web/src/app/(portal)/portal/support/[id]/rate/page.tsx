import { CSAT_SCORE_LABELS, CSAT_SCORES, getTicketRating } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { InlineAlert } from "@/components/inline-alert";
import { PageHeader } from "@/components/page-header";
import { PortalForm } from "@/components/portal/portal-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { ratePortalTicket } from "./actions";

export const dynamic = "force-dynamic";

/** The `?score=N` the "Was this sorted?" email's five links carry; anything else is no preselection. */
const ScoreParam = z.coerce.number().int().min(1).max(5);

type Score = (typeof CSAT_SCORES)[number];

function scoreLabel(score: number): string {
  return `${score} — ${CSAT_SCORE_LABELS[score as Score] ?? ""}`.trim();
}

/**
 * Five radio buttons drawn as a row of pills. A real `<input type="radio">`
 * sits inside each label so the keyboard, the screen reader and the plain
 * form post all work; the pill is the `<span>` styled off `peer-checked`.
 */
function ScorePicker({ selected }: { selected: number | null }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">How did we do?</legend>
      <div className="mt-2 grid grid-cols-5 gap-2 sm:max-w-md">
        {CSAT_SCORES.map((score) => (
          <label key={score} className="cursor-pointer">
            <input
              type="radio"
              name="score"
              value={score}
              defaultChecked={selected === score}
              aria-label={scoreLabel(score)}
              required
              className="peer sr-only"
            />
            <span className="flex flex-col items-center rounded-lg border bg-card px-2 py-3 text-center transition-colors peer-checked:border-primary peer-checked:bg-primary-soft peer-checked:text-primary peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 hover:bg-muted">
              <span className="text-lg font-semibold tabular-nums">{score}</span>
              <span className="text-meta">{CSAT_SCORE_LABELS[score]}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RatingForm({ ticketId, selected, submitLabel }: { ticketId: string; selected: number | null; submitLabel: string }) {
  return (
    <PortalForm action={ratePortalTicket} submitLabel={submitLabel} ariaLabel="Rate this request" success="Thank you — your rating has been saved.">
      <input type="hidden" name="ticketId" value={ticketId} />
      <ScorePicker selected={selected} />
      <div className="mt-4 space-y-1.5">
        <Label htmlFor="rating-comment">Anything you would like to add? (optional)</Label>
        <Textarea id="rating-comment" name="comment" rows={3} maxLength={2000} className="bg-card" />
      </div>
    </PortalForm>
  );
}

export default async function PortalRateTicketPage({ params, searchParams }: PageProps<"/portal/support/[id]/rate">) {
  const session = await requireClient();
  const [{ id }, sp] = await Promise.all([params, searchParams]);

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) notFound();
  const ticketId = parsedId.data;
  const preselected = ScoreParam.safeParse(sp.score);
  const selectedFromLink = preselected.success ? preselected.data : null;

  const db = getDb();
  // The same three-way scope as the case page: this client's, and visible to them.
  const [ticket] = await db
    .select({ id: schema.tickets.id, subject: schema.tickets.subject, status: schema.tickets.status })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.id, ticketId),
        eq(schema.tickets.organisationId, session.organisationId),
        eq(schema.tickets.clientId, session.clientId),
        eq(schema.tickets.clientVisible, true),
      ),
    );
  if (!ticket) notFound();

  const rating = await getTicketRating(db, session.organisationId, { ticketId });
  const resolved = ticket.status === "resolved" || ticket.status === "closed";

  return (
    <>
      <PageHeader
        title="Was this sorted?"
        description={ticket.subject}
        category="support"
        actions={
          <Button asChild variant="secondary">
            <Link href={`/portal/support/${ticket.id}`}>
              <ArrowLeft aria-hidden strokeWidth={1.75} />
              Back to the request
            </Link>
          </Button>
        }
      />

      <div className="max-w-2xl">
        {!resolved ? (
          <InlineAlert tone="info" title="This request is still open">
            You can rate it once it has been resolved. If it has been sorted and nobody has marked it so, reply on the
            request and we will close it.
          </InlineAlert>
        ) : rating ? (
          <div className="space-y-6">
            <InlineAlert tone="success" title="Thank you">
              You rated this request {rating.score} out of 5 — {CSAT_SCORE_LABELS[rating.score as Score] ?? ""}, on{" "}
              {formatDateTime(rating.ratedAt)}.
              {rating.comment ? <span className="mt-1 block whitespace-pre-wrap">“{rating.comment}”</span> : null}
            </InlineAlert>
            <details className="rounded-xl border bg-card p-4 sm:p-5">
              <summary className="cursor-pointer text-sm font-medium">Change your rating</summary>
              <div className="mt-4">
                <RatingForm ticketId={ticket.id} selected={selectedFromLink ?? rating.score} submitLabel="Update rating" />
              </div>
            </details>
          </div>
        ) : (
          <div className="rounded-xl border bg-card p-4 sm:p-5">
            <p className="mb-4 text-sm text-muted-foreground">
              One tap tells us whether this went well. Your score goes to the person who handled it and to the owner.
            </p>
            <RatingForm ticketId={ticket.id} selected={selectedFromLink} submitLabel="Send rating" />
          </div>
        )}
      </div>
    </>
  );
}
