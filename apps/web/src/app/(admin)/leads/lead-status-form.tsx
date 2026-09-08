"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { updateLeadStatusAction } from "./actions";

/**
 * The status changer on a board card.
 *
 * A select plus a submit button rather than drag-and-drop, for the same three
 * reasons the task board gives: no extra library, it works with a thumb on a
 * phone, and the board stays server-rendered.
 *
 * `converted` is not offered. A lead becomes a client through "Convert to
 * client" on its own page, which creates the client record and fires
 * `client.created`; setting the word by hand here would leave a lead marked
 * converted with nothing to show for it. `MANUAL_LEAD_STATUSES` is where that
 * rule lives, and it arrives as a prop because `@launchos/db` pulls in the
 * postgres driver and cannot be bundled for the browser.
 */
export function LeadStatusForm({
  leadId,
  status,
  statuses,
}: {
  leadId: string;
  status: string;
  statuses: readonly string[];
}) {
  // A converted lead is finished. Core refuses to move it, so the control says
  // so rather than offering an action that will only come back as a toast.
  if (status === "converted") {
    return <p className="text-meta text-muted-foreground">Converted — now a client.</p>;
  }

  return (
    <form
      action={async (formData) => {
        // The action revalidates /leads, so the moved card is re-rendered by
        // the server with no client-side refresh.
        const result = await updateLeadStatusAction(formData);
        if (result.status === "error") toast.error(result.message);
      }}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
    >
      <input type="hidden" name="leadId" value={leadId} />
      <NativeSelect key={status} name="status" defaultValue={status} aria-label="Status">
        {statuses.map((value) => (
          <option key={value} value={value}>
            {value.replaceAll("_", " ")}
          </option>
        ))}
      </NativeSelect>
      <Button type="submit" size="sm" variant="secondary">
        Move
      </Button>
    </form>
  );
}
