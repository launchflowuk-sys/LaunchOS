"use client";

import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The screenshot half of proof of work. Posts `multipart/form-data` to
 * `/api/tasks/[id]/evidence` — a route handler, because a server action caps
 * its body at 1 MB and a phone screenshot can be more — then refreshes the
 * server-rendered page so the new attachment appears in the list.
 */
export function ScreenshotUpload({ taskId, maxBytes, accept }: { taskId: string; maxBytes: number; accept: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const inputId = `screenshot-${taskId}`;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      toast.error("Choose a screenshot first.");
      return;
    }
    if (file.size > maxBytes) {
      toast.error(`That file is over ${Math.round(maxBytes / (1024 * 1024))} MB — crop it or export a smaller one.`);
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch(`/api/tasks/${taskId}/evidence`, { method: "POST", body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Upload failed (${response.status}).`);
      }
      toast.success("Screenshot added");
      if (input.current) input.current.value = "";
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That screenshot could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add screenshot" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>Screenshot</Label>
        <Input id={inputId} ref={input} type="file" name="file" accept={accept} className="file:mr-3 file:text-sm" />
      </div>
      <Button type="submit" variant="secondary" loading={busy} className="max-sm:w-full">
        <Upload aria-hidden strokeWidth={1.75} />
        Add screenshot
      </Button>
    </form>
  );
}
