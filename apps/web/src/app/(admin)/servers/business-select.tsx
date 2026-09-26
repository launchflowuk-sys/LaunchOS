"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { NativeSelect } from "@/components/ui/native-select";
import { businessAction } from "./actions";

/**
 * Which business a server's Hetzner bill belongs to.
 *
 * A client component cannot import `@launchos/core` (breaks the web bundle
 * with a `net` error typecheck does not catch — see the repo memory on this),
 * so the page passes the options down as plain `{ value, label }` pairs
 * instead of this component reading `COST_BUSINESSES`/`BUSINESS_LABELS`
 * itself.
 */
export function BusinessSelect({
  serverId,
  business,
  options,
}: {
  serverId: string;
  business: string;
  options: { value: string; label: string }[];
}) {
  const [value, setValue] = useState(business);
  const [isPending, startTransition] = useTransition();

  return (
    <NativeSelect
      value={value}
      disabled={isPending}
      className="h-9 min-w-36 text-sm"
      onChange={(event) => {
        const next = event.target.value;
        const previous = value;
        setValue(next);
        startTransition(async () => {
          const result = await businessAction(serverId, next);
          if (!result.ok) {
            setValue(previous);
            toast.error(result.message);
          }
        });
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </NativeSelect>
  );
}
