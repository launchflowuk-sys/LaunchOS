"use client";

import { Lock } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { setMemberPermissionsAction } from "./actions";
import { PermissionPicker, type PermissionOption } from "./permission-picker";

/**
 * The five keys and their labels, handed down from the server. Declared here
 * as a plain shape rather than imported from `@launchos/core`, which would
 * pull the Postgres driver into the browser bundle.
 */
export type { PermissionOption };

/**
 * One member's permissions: six boxes and a Save. An owner's row is locked
 * to all five — core refuses to narrow an owner — so the boxes are shown
 * ticked and disabled, and the form does not post at all.
 *
 * Every key posts an explicit `on` or `off` — see `PermissionPicker`. It used
 * to lean on "an unticked box submits nothing", which is exactly how saving
 * a narrowed set silently reset the row to the role defaults.
 */
export function PermissionsForm({
  memberId,
  name,
  role,
  permissions,
  options,
  editable,
}: {
  memberId: string;
  name: string;
  role: "owner" | "staff";
  permissions: Record<string, boolean>;
  options: readonly PermissionOption[];
  /** False for a reader without `settings`: the boxes show, nothing posts. */
  editable: boolean;
}) {
  const locked = role === "owner" || !editable;

  const boxes = (
    <PermissionPicker
      idPrefix={`perm-${memberId}`}
      options={options}
      // An owner is every permission whatever is stored — core refuses to
      // narrow one — so their row is shown full and switched off.
      initial={role === "owner" ? Object.fromEntries(options.map((o) => [o.key, true])) : permissions}
      disabled={locked}
    />
  );

  const heading = (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="text-sm font-medium">{name}</span>
      <span className="text-meta capitalize text-muted-foreground">{role}</span>
    </div>
  );

  if (role === "owner") {
    return (
      <div className="space-y-3 py-4" data-testid={`permissions-${memberId}`}>
        {heading}
        {boxes}
        <p className="flex items-center gap-1.5 text-meta text-muted-foreground">
          <Lock aria-hidden strokeWidth={1.75} className="size-3.5" />
          Owners always have every permission.
        </p>
      </div>
    );
  }

  return (
    <ActionForm
      action={setMemberPermissionsAction}
      ariaLabel={`Permissions for ${name}`}
      success={`Permissions saved for ${name}`}
      className="space-y-3 py-4"
    >
      <input type="hidden" name="memberId" value={memberId} />
      {heading}
      {boxes}
      {editable ? (
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" size="sm" className="max-sm:w-full">
            Save permissions
          </Button>
        </div>
      ) : null}
    </ActionForm>
  );
}
