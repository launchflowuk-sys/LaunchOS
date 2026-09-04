import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";

type ActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * How a client-facing reply on this case actually reaches the client. Said out
 * loud next to the mode switch, because "Reply to the client" means two
 * different deliveries and a staff member should not have to guess which.
 */
function deliveryNote(channel: string, clientVisible: boolean): string {
  if (channel === "email") return "A reply is emailed to the client and threaded onto their conversation.";
  if (!clientVisible) {
    return "This case is internal, so only a note can be added. Share it with the client to reply.";
  }
  return "A reply appears in the client's portal straight away; if we hold an address for them, they also get an email telling them to sign in.";
}

/**
 * The single composer on the case screen: an internal note or a reply to the
 * client, chosen with one control rather than two boxes that look alike.
 *
 * The default is the honest one for the case's origin — a client who wrote in
 * is waiting for an answer, and a case we raised about them starts private.
 * A server component: the action is passed down to `ActionForm`, so no
 * `@launchos/core` import reaches the browser bundle.
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
  defaultMode: "reply" | "note";
}) {
  // An internal case has nowhere to put a client-facing reply, and core
  // refuses one; not offering it is better than a toast after the fact.
  const canReply = clientVisible || channel === "email";

  return (
    <ActionForm
      action={action}
      ariaLabel="Case message"
      success="Message posted"
      resetOnSuccess
      className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4"
    >
      <input type="hidden" name="ticketId" value={ticketId} />
      <label className="block text-sm font-medium text-neutral-700">
        Message type
        <select
          name="mode"
          defaultValue={canReply ? defaultMode : "note"}
          className="mt-1 block h-9 w-56 rounded-md border border-neutral-300 bg-white px-2 text-sm font-normal text-neutral-900"
        >
          {canReply ? <option value="reply">Reply to the client</option> : null}
          <option value="note">Internal note</option>
        </select>
      </label>
      <p className="text-xs text-neutral-500">{deliveryNote(channel, clientVisible)}</p>
      <textarea
        name="body"
        rows={4}
        required
        maxLength={8000}
        aria-label="Message body"
        placeholder={canReply ? "What the client should be told, or a note for the team" : "Only the team sees this"}
        className="w-full rounded-md border border-neutral-300 p-2 text-sm text-neutral-900"
      />
      <Button type="submit">Post message</Button>
    </ActionForm>
  );
}
