"use client";

import { Lock } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { setMemberPermissionsAction } from "./actions";

/**
 * The five keys and their labels, handed down from the server. Declared here
 * as a plain shape rather than imported from `@launchos/core`, which would
 * pull the Postgres driver into the browser bundle.
 */
export type PermissionOption = { key: string; label: string };

/**
 * One member's permissions: five boxes and a Save. An owner's row is locked
 * to all five — core refuses to narrow an owner — so the boxes are shown
 * ticked and disabled, and the form does not post at all.
 *
 * Radix's Checkbox submits `name=on` with the enclosing form when ticked and
 * nothing when not, and the action stores the whole set, so an unticked box
 * is a clear `false`.
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
    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {options.map((option) => {
        const id = `perm-${memberId}-${option.key}`;
        return (
          <div key={option.key} className="flex items-start gap-2">
            <Checkbox
              id={id}
              name={option.key}
              defaultChecked={role === "owner" ? true : permissions[option.key] === true}
              disabled={locked}
              className="mt-0.5"
            />
            <Label htmlFor={id} className="leading-snug font-normal">
              {option.label}
            </Label>
          </div>
        );
      })}
    </div>
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
