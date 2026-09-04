"use client";

import { toast } from "sonner";
import { updateTaskStatusAction } from "./actions";

/**
 * One reusable status changer, used by both the list and the board. A select
 * plus a submit button rather than drag-and-drop: no extra library, it works on
 * a phone, and the board stays server-rendered.
 *
 * The statuses arrive as a prop rather than from `schema.taskStatusEnum`:
 * `@launchos/db` pulls in the postgres driver, which cannot be bundled for the
 * browser, and this is a client component.
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
      className="flex items-center gap-1"
    >
      <input type="hidden" name="taskId" value={taskId} />
      <select
        name="status"
        defaultValue={status}
        aria-label="Status"
        className="h-8 rounded-md border border-neutral-300 bg-white px-1.5 text-xs text-neutral-900"
      >
        {statuses.map((v) => (
          <option key={v} value={v}>
            {v.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
      >
        Move
      </button>
    </form>
  );
}
