"use client";

import { useId, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { createTaskAction } from "./actions";

type Option = { value: string; label: string };

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
  const ids = {
    client: useId(),
    title: useId(),
    phase: useId(),
    kind: useId(),
    priority: useId(),
    due: useId(),
    assignee: useId(),
    description: useId(),
  };

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
          <div className="space-y-1.5">
            <Label htmlFor={ids.client}>Client</Label>
            <NativeSelect id={ids.client} name="clientId" required defaultValue={defaultClientId ?? ""}>
              <option value="" disabled>
                Choose a client
              </option>
              {clients.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={ids.title}>Title</Label>
            <Input id={ids.title} name="title" required maxLength={200} placeholder="Write October blog post" />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={ids.phase}>Phase</Label>
              <NativeSelect id={ids.phase} name="phase" defaultValue="support">
                {phases.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.kind}>Kind</Label>
              <NativeSelect id={ids.kind} name="kind" defaultValue="other">
                {kinds.map((v) => (
                  <option key={v} value={v}>
                    {v.replaceAll("_", " ")}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.priority}>Priority</Label>
              <NativeSelect id={ids.priority} name="priority" defaultValue="medium">
                {priorities.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.due}>Due date</Label>
              <Input id={ids.due} type="date" name="dueAt" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.assignee}>Assignee</Label>
              <NativeSelect id={ids.assignee} name="assigneeUserId" defaultValue="">
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={ids.description}>Description</Label>
            <Textarea id={ids.description} name="descriptionMd" rows={4} />
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Create task</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
