"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Mirrors core's CONTENT_ASSET_MIMES — the `accept` list the file picker shows. */
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * One image plus alt text, posted as multipart to an upload route and
 * followed by a router refresh so the server-rendered grid picks it up.
 * Used by the staff library (`/api/clients/[id]/assets`) and the portal's
 * "Add photos" (`/api/portal/assets`); the copy and ids are the caller's,
 * the plumbing is shared.
 *
 * `fetch` rather than a server action: server actions cap the body at 1 MB
 * and a phone photo is more. The result is shown inline — the portal has no
 * toaster, and next to the field is where a client looks anyway.
 */
export function ImageUploadForm({
  endpoint,
  idPrefix,
  submitLabel,
  altLabel = "Describe the photo (optional)",
  altHint,
  fileLabel = "Photo",
  success = "Photo added",
  ariaLabel,
  onUploaded,
  tall = false,
}: {
  endpoint: string;
  idPrefix: string;
  submitLabel: string;
  altLabel?: string;
  altHint?: string;
  fileLabel?: string;
  success?: string;
  ariaLabel: string;
  onUploaded?: (asset: { id: string }) => void;
  /** 44px controls for the portal, where the form is used on a phone by someone who rarely signs in. */
  tall?: boolean;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const control = tall ? "h-11 bg-card text-base" : undefined;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setResult({ tone: "danger", message: "Choose a photo first." });
      return;
    }
    setPending(true);
    setResult(null);
    try {
      const res = await fetch(endpoint, { method: "POST", body: data });
      const json = (await res.json().catch(() => ({}))) as { error?: string; asset?: { id: string } };
      if (!res.ok) {
        setResult({ tone: "danger", message: json.error ?? "That photo could not be uploaded." });
        return;
      }
      form.current?.reset();
      setResult({ tone: "success", message: success });
      if (json.asset) onUploaded?.(json.asset);
      router.refresh();
    } catch {
      setResult({ tone: "danger", message: "That photo could not be uploaded. Check the connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={form} onSubmit={onSubmit} aria-label={ariaLabel} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-file`}>{fileLabel}</Label>
          <Input id={`${idPrefix}-file`} name="file" type="file" accept={IMAGE_ACCEPT} required className={control} />
          <p className="text-meta text-muted-foreground">JPEG, PNG or WebP, up to 8 MB.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-alt`}>{altLabel}</Label>
          <Input id={`${idPrefix}-alt`} name="alt" maxLength={500} placeholder="The van outside the office" className={control} />
          {altHint ? <p className="text-meta text-muted-foreground">{altHint}</p> : null}
        </div>
      </div>
      {result ? <InlineAlert tone={result.tone}>{result.message}</InlineAlert> : null}
      <div className="flex sm:justify-end">
        <Button type="submit" loading={pending} size={tall ? "lg" : "md"} className="max-sm:w-full">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
