import { schema } from "@launchos/db";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

type Option = { value: string; label: string };

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
    <form method="get" aria-label="Task filters">
      <FilterBar>
        <input type="hidden" name="view" value={current.view ?? "list"} />
        {selects.map((s) => (
          <ToolbarField key={s.name} label={s.label} htmlFor={`filter-${s.name}`} className="sm:w-40">
            <NativeSelect key={current[s.name] ?? ""} id={`filter-${s.name}`} name={s.name} defaultValue={current[s.name] ?? ""}>
              <option value="">Any</option>
              {s.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </ToolbarField>
        ))}
        <ToolbarField label="Due from" htmlFor="filter-dueFrom" className="sm:w-40">
          <Input id="filter-dueFrom" type="date" name="dueFrom" defaultValue={current.dueFrom ?? ""} />
        </ToolbarField>
        <ToolbarField label="Due to" htmlFor="filter-dueTo" className="sm:w-40">
          <Input id="filter-dueTo" type="date" name="dueTo" defaultValue={current.dueTo ?? ""} />
        </ToolbarField>
        <ToolbarActions>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </ToolbarActions>
      </FilterBar>
    </form>
  );
}
