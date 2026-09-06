"use client";

import { useRef, useState, useTransition } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { approveClientReview, commentOnClientReview } from "./actions";
import type { ActionResult } from "./schemas";

/**
 * An invitation, never a blocker.
 *
 * Shoji's rule is that a client may approve a design but nothing waits on
 * them, and this card has to say so before it asks for anything — otherwise a
 * client who is away for a week believes their website is sitting still
 * because of them. So the line under the heading is the first thing read, both
 * buttons are equal weight, and neither of them is called "Reject": a comment
 * is a message, not a refusal, and the work carries on either way.
 *
 * Two buttons over one form rather than two forms, so the note the client
 * types is shared: somebody who writes "love it, one thing about the header"
 * should be able to press either button without retyping it.
 */
export function ReviewCard({
  approvalId,
  title,
  note,
  screenshots,
}: {
  approvalId: string;
  title: string;
  /** What we asked them to look at, in our words. */
  note: string | null;
  screenshots: readonly { url: string; label: string }[];
}) {
  const form = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const send = (action: (formData: FormData) => Promise<ActionResult>) => {
    const data = new FormData(form.current ?? undefined);
    data.set("approvalId", approvalId);
    start(async () => {
      const answer = await action(data);
      setResult(answer);
      if (answer.status === "ok") form.current?.reset();
    });
  };

  return (
    <div className="rounded-xl border bg-card p-4 sm:p-5">
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Whenever you get a chance. We are carrying on with the build either way — nothing is waiting on this.
      </p>
      {note ? <p className="mt-3 text-base break-words">{note}</p> : null}

      {screenshots.length > 0 ? (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {screenshots.map((shot) => (
            <li key={shot.url} className="min-w-0">
              {/* A plain img: these are assets we uploaded a moment ago at
                  sizes we do not know, and `next/image` would need both. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shot.url} alt={shot.label} className="w-full rounded-lg border" />
              <p className="mt-1 text-meta text-muted-foreground">{shot.label}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <form ref={form} className="mt-4">
        <input type="hidden" name="approvalId" value={approvalId} />
        <div className="space-y-1.5">
          <Label htmlFor={`review-note-${approvalId}`}>Anything you would like to say?</Label>
          <Textarea
            id={`review-note-${approvalId}`}
            name="note"
            rows={3}
            maxLength={1000}
            placeholder="Optional. A comment is not a hold-up — we will pick it up and carry on."
          />
        </div>

        {result?.status === "error" ? (
          <InlineAlert tone="danger" className="mt-4">
            {result.message}
          </InlineAlert>
        ) : null}
        {result?.status === "ok" ? (
          <InlineAlert tone="success" className="mt-4">
            Thank you — that is with us.
          </InlineAlert>
        ) : null}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button type="button" size="lg" loading={pending} onClick={() => send(approveClientReview)} className="w-full sm:w-auto">
            Happy with this
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            loading={pending}
            onClick={() => send(commentOnClientReview)}
            className="w-full sm:w-auto"
          >
            Send a comment
          </Button>
        </div>
      </form>
    </div>
  );
}
