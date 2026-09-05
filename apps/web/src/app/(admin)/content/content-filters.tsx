import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { CHANNEL_NAME } from "./presentation";
import { CONTENT_CHANNELS, CONTENT_STATUSES } from "./schemas";

type Option = { value: string; label: string };

export type ContentFilterValues = {
  period: string;
  client?: string | undefined;
  status?: string | undefined;
  channel?: string | undefined;
};

/**
 * A plain GET form — no client JavaScript, so the filters live in the URL and
 * a filtered month is shareable. The month is the one filter that is always
 * set: the list is a month's plan, not an endless queue.
 */
export function ContentFilterBar({ clients, current }: { clients: readonly Option[]; current: ContentFilterValues }) {
  const selects: { name: "client" | "status" | "channel"; label: string; options: readonly Option[] }[] = [
    { name: "client", label: "Client", options: clients },
    {
      name: "status",
      label: "Status",
      options: CONTENT_STATUSES.map((status) => ({ value: status, label: status.replaceAll("_", " ") })),
    },
    {
      name: "channel",
      label: "Channel",
      options: CONTENT_CHANNELS.map((channel) => ({ value: channel, label: CHANNEL_NAME[channel] })),
    },
  ];

  return (
    <form method="get" aria-label="Content filters">
      <FilterBar>
        <ToolbarField label="Month" htmlFor="filter-period" className="sm:w-44">
          <Input id="filter-period" type="month" name="period" defaultValue={current.period} />
        </ToolbarField>
        {selects.map((select) => (
          <ToolbarField key={select.name} label={select.label} htmlFor={`filter-${select.name}`} className="sm:w-44">
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
