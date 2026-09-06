import { AGENT_RUN_STATUSES, AGENT_RUN_TRIGGERS } from "@launchos/core";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

export type RunFilterValues = {
  agent?: string | undefined;
  status?: string | undefined;
  trigger?: string | undefined;
};

/**
 * A plain GET form, like the content filters: no client JavaScript, the
 * filters live in the URL, and "every failed run of the content writer" is a
 * link somebody can keep.
 *
 * The agent list comes from the runs themselves rather than the registry, so
 * an agent that has never run is not offered as a filter that would return
 * nothing, and one that has been removed from the code still finds its history.
 */
export function RunFilterBar({ agents, current }: { agents: readonly string[]; current: RunFilterValues }) {
  const selects = [
    { name: "agent", label: "Agent", options: agents.map((key) => ({ value: key, label: key })) },
    {
      name: "status",
      label: "Status",
      options: AGENT_RUN_STATUSES.map((status) => ({ value: status, label: status.replaceAll("_", " ") })),
    },
    { name: "trigger", label: "Trigger", options: AGENT_RUN_TRIGGERS.map((t) => ({ value: t, label: t })) },
  ] as const;

  return (
    <form method="get" aria-label="Agent run filters">
      <FilterBar>
        {selects.map((select) => (
          <ToolbarField key={select.name} label={select.label} htmlFor={`filter-${select.name}`} className="sm:w-48">
            <NativeSelect id={`filter-${select.name}`} name={select.name} defaultValue={current[select.name] ?? ""}>
              <option value="">Any</option>
              {select.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </ToolbarField>
        ))}
        <ToolbarActions>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </ToolbarActions>
      </FilterBar>
    </form>
  );
}
