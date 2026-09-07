"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { updateTaskStatusAction } from "./actions";

/**
 * One reusable status changer, used by both the list and the board. A select
 * plus a submit button rather than drag-and-drop: no extra library, it works on
 * a phone, and the board stays server-rendered.
 *
 * The statuses arrive as a prop rather than from `schema.taskStatusEnum`:
 * `@launchos/db` pulls in the postgres driver, which cannot be bundled for the
 * browser, and this is a client component.
 *
 * The row is a grid, not a flex row: `DataList` stretches every button inside a
 * row action to full width on a phone, which in a flex row would push the
 * select off the card. In a grid the button fills an `auto` track, so it stays
 * its own size and the select keeps the rest.
 */
export function TaskStatusForm({
  taskId,
  status,
  statuses,
}: {
  taskId: string;
  status: string;
  statuses: readonly string[];
}) {
  return (
    <form
      action={async (formData) => {
        // The action revalidates /tasks on success, so the moved card is
        // re-rendered by the server without a client-side refresh.
        const result = await updateTaskStatusAction(formData);
        if (result.status === "error") toast.error(result.message);
      }}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
    >
      <input type="hidden" name="taskId" value={taskId} />
      <NativeSelect key={status} name="status" defaultValue={status} aria-label="Status" className="sm:w-36">
        {statuses.map((v) => (
          <option key={v} value={v}>
            {v.replaceAll("_", " ")}
          </option>
        ))}
      </NativeSelect>
      <Button type="submit" size="sm" variant="secondary">
        Move
      </Button>
    </form>
  );
}
