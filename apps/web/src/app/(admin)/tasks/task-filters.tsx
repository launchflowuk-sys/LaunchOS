import { schema } from "@launchos/db";
import { Button } from "@/components/ui/button";

type Option = { value: string; label: string };

const CONTROL = "h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";

/**
 * A plain GET form — no client JavaScript, so the filters live in the URL and
 * a filtered view is shareable and bookmarkable.
 */
export function TaskFilterBar({
  clients,
  members,
  current,
}: {
  clients: Option[];
  members: Option[];
  current: Record<string, string | undefined>;
}) {
  const selects: { name: string; label: string; options: Option[] }[] = [
    { name: "client", label: "Client", options: clients },
    {
      name: "assignee",
      label: "Assignee",
      options: [{ value: "unassigned", label: "Unassigned" }, ...members],
    },
    {
      name: "phase",
      label: "Phase",
      options: schema.taskPhaseEnum.enumValues.map((v) => ({ value: v, label: v })),
    },
    {
      name: "kind",
      label: "Kind",
      options: schema.taskKindEnum.enumValues.map((v) => ({ value: v, label: v.replaceAll("_", " ") })),
    },
    {
      name: "status",
      label: "Status",
      options: schema.taskStatusEnum.enumValues.map((v) => ({ value: v, label: v.replaceAll("_", " ") })),
    },
  ];

  return (
    <form
      method="get"
      aria-label="Task filters"
      className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-3"
    >
      <input type="hidden" name="view" value={current.view ?? "list"} />
      {selects.map((s) => (
        <label key={s.name} className="flex flex-col gap-1 text-xs text-neutral-500">
          {s.label}
          <select name={s.name} defaultValue={current[s.name] ?? ""} className={`${CONTROL} min-w-40`}>
            <option value="">Any</option>
            {s.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label className="flex flex-col gap-1 text-xs text-neutral-500">
        Due from
        <input type="date" name="dueFrom" defaultValue={current.dueFrom ?? ""} className={CONTROL} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-500">
        Due to
        <input type="date" name="dueTo" defaultValue={current.dueTo ?? ""} className={CONTROL} />
      </label>
      <Button type="submit" variant="outline">
        Apply
      </Button>
    </form>
  );
}
