import type { ClientReviewSummary, ProjectMilestoneRow } from "@launchos/core";
import { Eye, MessageSquare, Send } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/format";
import { requestClientReviewAction, withdrawClientReviewAction } from "../actions";

/**
 * "Have a look at this" — the one door into a client review, and until now
 * there was none.
 *
 * `requestClientReview` has existed in core, tested, since P4b, and nothing in
 * the application ever called it. The client could answer a review and the
 * morning brief could count the unanswered ones, but no screen, route or agent
 * could raise one — so the portal's "One thing to look at" panel was wired to
 * a queue that would have stayed empty for ever.
 *
 * Two deliberate absences on this panel:
 *
 * - **No approve or reject button.** The client decides a client review.
 *   Answering one here would write "the client is happy with this" onto a
 *   timeline on nobody's authority, so the only thing we can do to an open
 *   review is take it back.
 * - **No "chase" button.** A review blocks nothing by design; chasing would
 *   ask the client to hurry over something we have just told them is not
 *   holding anything up. An unanswered one earns a line in the morning brief
 *   after five days, and a phone call is what actually works.
 *
 * The age is shown rather than hidden because it is the only consequence
 * silence has: it is what the brief will pick up, so it should be visible here
 * before the brief mentions it.
 */
export function ClientReviewsPanel({
  projectId,
  reviews,
  milestones,
}: {
  projectId: string;
  reviews: readonly ClientReviewSummary[];
  milestones: readonly ProjectMilestoneRow[];
}) {
  const open = reviews.filter((review) => review.status === "pending");
  const settled = reviews.filter((review) => review.status !== "pending");

  // Only milestones the client can see. Asking somebody to look at a
  // milestone marked internal would show them a row that does not exist on
  // their own progress page.
  const askable = milestones.filter((milestone) => milestone.clientVisible);

  return (
    <div className="grid gap-4">
      {reviews.length === 0 ? (
        <EmptyState icon={Eye}>
          Nothing has been sent for review. A review is an invitation, not a gate — the build carries on whether they
          answer or not.
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {[...open, ...settled].map((review) => (
            <li key={review.approvalId} className="min-w-0 rounded-[20px] border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium break-words">{review.about}</p>
                  <p className="mt-0.5 text-meta text-muted-foreground">
                    Asked {formatDate(review.requestedAt)}
                    {review.status === "pending" && review.commentedAt === null
                      ? ` · waiting ${review.daysWaiting} ${review.daysWaiting === 1 ? "day" : "days"}`
                      : ""}
                    {review.commentedAt ? ` · they replied ${formatDate(review.commentedAt)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {review.comments.length > 0 ? (
                    <StatusBadge
                      value="commented"
                      tone="warn"
                      label={`${review.comments.length} ${review.comments.length === 1 ? "comment" : "comments"}`}
                    />
                  ) : null}
                  <StatusBadge
                    value={review.status}
                    tone={review.status === "approved" ? "success" : review.status === "pending" ? "neutral" : "danger"}
                    label={review.status === "approved" ? "Happy with it" : review.status === "pending" ? "Waiting on them" : "Answered"}
                  />
                </div>
              </div>

              <p className="mt-2 text-sm break-words text-muted-foreground">{review.note}</p>

              {review.links.length > 0 ? (
                <ul className="mt-2 grid gap-1">
                  {review.links.map((link) => (
                    <li key={link} className="min-w-0">
                      <a
                        href={link}
                        target="_blank"
                        rel="noreferrer"
                        className="text-meta break-all text-muted-foreground hover:underline"
                      >
                        {link}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* What they actually said. The whole reason a comment does not
                  close the card is that the conversation continues, so the
                  conversation is on the card. */}
              {review.comments.length > 0 ? (
                <ul className="mt-3 grid gap-2 border-t pt-3">
                  {review.comments.map((comment) => (
                    <li key={`${comment.at}-${comment.byUserId}`} className="min-w-0">
                      <p className="text-meta text-muted-foreground">
                        <MessageSquare className="mr-1 inline size-3 align-[-1px]" aria-hidden />
                        {formatDate(comment.at)}
                      </p>
                      <p className="mt-0.5 text-sm break-words">{comment.body}</p>
                    </li>
                  ))}
                </ul>
              ) : null}

              {review.status === "pending" ? (
                <div className="mt-3">
                  <ActionForm
                    action={withdrawClientReviewAction}
                    success="Review withdrawn — you can ask about it again"
                    className="max-sm:w-full"
                  >
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="approvalId" value={review.approvalId} />
                    <Button type="submit" variant="ghost" size="sm" className="max-sm:w-full">
                      Withdraw
                    </Button>
                  </ActionForm>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-[20px] border bg-card p-5">
        <ActionForm
          action={requestClientReviewAction}
          success="Asked — it is in their portal now, and it holds nothing up"
          resetOnSuccess
          className="grid gap-4"
        >
          <input type="hidden" name="projectId" value={projectId} />

          <div className="grid gap-1.5">
            <Label htmlFor="review-milestone">What about?</Label>
            <NativeSelect id="review-milestone" name="milestoneId" defaultValue="">
              <option value="">The project as a whole</option>
              {askable.map((milestone) => (
                <option key={milestone.id} value={milestone.id}>
                  {milestone.title}
                </option>
              ))}
            </NativeSelect>
            <p className="text-meta text-muted-foreground">
              One open review per thing at a time. Milestones marked internal are not listed — they are not on the
              client&rsquo;s page.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="review-note">What would you like them to look at?</Label>
            <Textarea
              id="review-note"
              name="note"
              rows={4}
              maxLength={4000}
              required
              placeholder="The homepage and the booking form are on the staging link. Have a look at the wording on the prices page in particular — happy to change any of it."
            />
            <p className="text-meta text-muted-foreground">They read this word for word, so write it to them.</p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="review-links">Links, one per line</Label>
            <Textarea id="review-links" name="links" rows={2} placeholder="https://staging.example.co.uk" />
            <p className="text-meta text-muted-foreground">Anything they can open without a login.</p>
          </div>

          <Button type="submit" className="justify-self-start max-sm:w-full">
            <Send aria-hidden />
            Ask the client
          </Button>
        </ActionForm>
      </div>
    </div>
  );
}
