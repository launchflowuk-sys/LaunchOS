"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ActionResult = { status: "ok" } | { status: "error"; message: string };
type Mode = "reply" | "note";

/**
 * What the composer is about to do, said in the present tense and coloured.
 *
 * One box now has two deliveries, and the difference between them is a message
 * the client reads or never sees, so the state has to be unmistakable at a
 * glance rather than inferred from a control's current value.
 */
function modeNotice(mode: Mode, channel: string): { text: string; className: string } {
  if (mode === "note") {
    return {
      text: "Internal note — staff only",
      className: "border-neutral-border bg-neutral-bg text-neutral-fg",
    };
  }
  return {
    text:
      channel === "email"
        ? "Replying to the client — emailed to them"
        : "Replying to the client — visible in their portal",
    className: "border-warning-border bg-warning-bg text-warning-fg",
  };
}

/** The small print under the strip: how a reply in this mode actually travels. */
function deliveryNote(mode: Mode, channel: string, clientVisible: boolean): string {
  if (mode === "note") return "Nothing here leaves LaunchOS. The client never sees an internal note.";
  if (channel === "email") return "Emailed to the client and threaded onto their conversation.";
  if (!clientVisible) return "This case is internal. Share it with the client before replying.";
  return "It appears in the client's portal straight away; if we hold an address for them, they also get an email telling them to sign in.";
}

/**
 * The single composer on the case screen: an internal note or a reply to the
 * client, chosen with one control rather than two boxes that look alike.
 *
 * A client component, and deliberately so. The mode is React state, not a form
 * control's value: `ActionForm` clears the box on success with `form.reset()`,
 * and `reset()` restores every control to its `defaultValue` — so a mode kept
 * in the DOM would silently spring back to whatever the case opened on after
 * every post. On a portal case that default is "reply", which means the second
 * internal note in a row would have gone to the client. State survives the
 * reset, so the composer stays in the mode it was last posted in and the only
 * thing that changes it is somebody choosing.
 *
 * The chosen mode is written into the FormData on submit rather than posted
 * from a hidden input, for the same reason: nothing a `reset` can touch decides
 * who reads the message.
 */
export function CaseComposer({
  action,
  ticketId,
  channel,
  clientVisible,
  defaultMode,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  ticketId: string;
  channel: string;
  clientVisible: boolean;
  /** "reply" for a case the client raised, "note" for one we raised about them. */
  defaultMode: Mode;
}) {
  // An internal case has nowhere to put a client-facing reply, and core
  // refuses one; not offering it is better than a toast after the fact.
  const canReply = clientVisible || channel === "email";
  const [chosen, setChosen] = useState<Mode>(canReply ? defaultMode : "note");
  // A case hidden from the client again while the composer is open must not
  // keep a reply selected underneath a control that no longer offers it.
  const mode: Mode = canReply ? chosen : "note";
  const notice = modeNotice(mode, channel);

  return (
    <ActionForm
      action={(formData) => {
        formData.set("mode", mode);
        return action(formData);
      }}
      ariaLabel="Case message"
      success={mode === "reply" ? "Reply sent to the client" : "Note added"}
      resetOnSuccess
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <input type="hidden" name="ticketId" value={ticketId} />

      <div role="group" aria-label="Message type" className="flex flex-wrap gap-2">
        {canReply ? (
          <Button
            type="button"
            size="sm"
            variant={mode === "reply" ? "primary" : "secondary"}
            aria-pressed={mode === "reply"}
            onClick={() => setChosen("reply")}
          >
            Reply to the client
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={mode === "note" ? "primary" : "secondary"}
          aria-pressed={mode === "note"}
          onClick={() => setChosen("note")}
        >
          Internal note
        </Button>
      </div>

      <p role="status" className={`rounded-lg border px-3 py-2 text-sm font-medium ${notice.className}`}>
        {notice.text}
      </p>
      <p className="text-meta text-muted-foreground">{deliveryNote(mode, channel, clientVisible)}</p>

      <Textarea
        name="body"
        rows={4}
        required
        maxLength={8000}
        aria-label="Message body"
        placeholder={mode === "reply" ? "What the client should be told" : "Only the team sees this"}
      />
      {/* The button says which of the two things pressing it does. */}
      <Button type="submit" className="max-sm:w-full">
        {mode === "reply" ? "Send to client" : "Add note"}
      </Button>
    </ActionForm>
  );
}
