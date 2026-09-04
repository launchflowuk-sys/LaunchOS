"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createTaskAction } from "./actions";

type Option = { value: string; label: string };

const FIELD = "h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";

/**
 * The enum values arrive as props rather than from `schema.*Enum`:
 * `@launchos/db` pulls in the postgres driver, which cannot be bundled for the
 * browser, and this is a client component.
 */
export function NewTaskDialog({
  clients,
  members,
  phases,
  kinds,
  priorities,
  defaultClientId,
}: {
  clients: Option[];
  members: Option[];
  phases: readonly string[];
  kinds: readonly string[];
  priorities: readonly string[];
  defaultClientId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New task</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>
        <form
          action={async (formData) => {
            const result = await createTaskAction(formData);
            if (result.status === "error") return void toast.error(result.message);
            toast.success("Task created");
            setOpen(false);
          }}
          className="space-y-3"
        >
          <label className="block text-xs text-neutral-500">
            Client
            <select name="clientId" required defaultValue={defaultClientId ?? ""} className={FIELD}>
              <option value="" disabled>
                Choose a client
              </option>
              {clients.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-neutral-500">
            Title
            <input name="title" required maxLength={200} className={FIELD} placeholder="Write October blog post" />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="block text-xs text-neutral-500">
              Phase
              <select name="phase" defaultValue="support" className={FIELD}>
                {phases.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-neutral-500">
              Kind
              <select name="kind" defaultValue="other" className={FIELD}>
                {kinds.map((v) => (
                  <option key={v} value={v}>
                    {v.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-neutral-500">
              Priority
              <select name="priority" defaultValue="medium" className={FIELD}>
                {priorities.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-neutral-500">
              Due date
              <input type="date" name="dueAt" className={FIELD} />
            </label>
            <label className="block text-xs text-neutral-500">
              Assignee
              <select name="assigneeUserId" defaultValue="" className={FIELD}>
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-xs text-neutral-500">
            Description
            <textarea name="descriptionMd" rows={4} className="w-full rounded-md border border-neutral-300 bg-white p-2 text-sm" />
          </label>
          <DialogFooter>
            <Button type="submit">Create task</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
