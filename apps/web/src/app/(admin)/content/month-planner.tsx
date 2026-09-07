"use client";

import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { contentMonthAction } from "./actions";

type Option = { value: string; label: string };

/**
 * `useFormStatus` reports the form it is rendered inside, so the two buttons
 * are one component each. The `intent` on the button travels in the FormData
 * as the submitter, which is how one form serves both actions.
 */
function IntentButton({ intent, label, variant }: { intent: "plan" | "draft"; label: string; variant: "primary" | "secondary" }) {
  const { pending, data } = useFormStatus();
  const isMine = pending && data?.get("intent") === intent;
  return (
    <Button type="submit" name="intent" value={intent} variant={variant} loading={isMine} disabled={pending && !isMine}>
      {label}
    </Button>
  );
}

/**
 * "Plan this month" fills the month with the package's empty slots; "Draft
 * with AI" sends those slots to the content writer. The month and client
 * default to whatever the list is filtered on, so planning what you are
 * looking at is two clicks.
 */
export function MonthPlanner({
  clients,
  periodKey,
  clientId,
}: {
  clients: readonly Option[];
  periodKey: string;
  clientId?: string | undefined;
}) {
  return (
    <form
      aria-label="Plan a month"
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:flex-wrap sm:items-end"
      action={async (formData) => {
        const result = await contentMonthAction(formData);
        if (result.status === "error") return void toast.error(result.message);
        if (formData.get("intent") === "draft") {
          return void toast.success("Sent to the content writer — drafts land here as it finishes each slot");
        }
        const [created = "0", skipped = "0"] = (result.id ?? "").split(":");
        toast.success(
          Number(created) > 0
            ? `Planned ${created} ${created === "1" ? "slot" : "slots"} for the month${Number(skipped) > 0 ? ` (${skipped} already there)` : ""}`
            : "The month was already planned — nothing new to add",
        );
      }}
    >
      <div className="min-w-0 space-y-1.5 sm:w-64">
        <Label htmlFor="planner-client">Client</Label>
        <NativeSelect key={clientId ?? ""} id="planner-client" name="clientId" defaultValue={clientId ?? ""} required>
          <option value="" disabled>
            Choose a client
          </option>
          {clients.map((client) => (
            <option key={client.value} value={client.value}>
              {client.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="min-w-0 space-y-1.5 sm:w-44">
        <Label htmlFor="planner-period">Month</Label>
        <Input id="planner-period" type="month" name="periodKey" defaultValue={periodKey} required />
      </div>
      <div className="flex flex-col gap-2 sm:ml-auto sm:flex-row max-sm:[&>*]:w-full">
        <IntentButton intent="plan" label="Plan this month" variant="secondary" />
        <IntentButton intent="draft" label="Draft with AI" variant="primary" />
      </div>
    </form>
  );
}
