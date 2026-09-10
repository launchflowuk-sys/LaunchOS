"use client";

import { Loader2, Paperclip, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

/**
 * The attachments on stage six.
 *
 * A file is listed only once the server has it. Showing a name the moment it is
 * chosen would mean a customer pressing Continue believing their logo went with
 * the brief when the upload was still in flight — or had been refused.
 *
 * Refusals are per file and keep the rest: choosing four photos where one is a
 * 30MB TIFF should attach three and explain the fourth, not throw the lot away.
 */

interface Attachment {
  id: string;
  name: string;
  bytes: number;
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadField({ label, hint }: { label: string; hint?: string | undefined }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/brief-funnel/assets", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { assets: Attachment[] };
      setAttachments(body.assets);
    })();
  }, []);

  const upload = async (files: FileList) => {
    setBusy(true);
    setRefusals([]);
    const failed: string[] = [];
    // One at a time, so a refusal names the file it belongs to and the count
    // limit is applied against what has actually landed.
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/brief-funnel/assets", { method: "POST", body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        failed.push(`${file.name} — ${body?.error?.message ?? "could not be attached"}`);
        continue;
      }
      const body = (await response.json()) as { asset: Attachment };
      setAttachments((current) => [...current, body.asset]);
    }
    setRefusals(failed);
    setBusy(false);
    if (input.current) input.current.value = "";
  };

  const remove = async (assetId: string) => {
    const response = await fetch(`/api/brief-funnel/assets?id=${encodeURIComponent(assetId)}`, { method: "DELETE" });
    if (response.ok) setAttachments((current) => current.filter((asset) => asset.id !== assetId));
  };

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-[15px] font-medium text-[#111827]">
        {label}
      </label>
      {hint ? <p className="text-[13.5px] leading-snug text-[#626D80]">{hint}</p> : null}

      <div className="rounded-[16px] border border-dashed border-[#C9D3E0] bg-[#FAFBFC] p-5 text-center">
        <input
          ref={input}
          id={id}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,application/pdf"
          className="sr-only"
          onChange={(event) => {
            if (event.target.files?.length) void upload(event.target.files);
          }}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-[11px] bg-white px-4 text-[14.5px] font-medium text-[#111827] shadow-sm ring-1 ring-[#DFE4EB] transition hover:ring-[#B9C4D2] disabled:opacity-60"
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Paperclip aria-hidden className="size-4" />}
          {busy ? "Attaching…" : "Choose files"}
        </button>
        <p className="mt-2 text-[13px] text-[#626D80]">PNG, JPEG, WebP or PDF · up to 10MB each</p>
      </div>

      {attachments.length > 0 ? (
        <ul className="space-y-2">
          {attachments.map((asset) => (
            <li key={asset.id} className="flex items-center justify-between gap-3 rounded-[12px] border border-[#DFE4EB] bg-white px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[14.5px] text-[#111827]">{asset.name}</span>
              <span className="shrink-0 text-[13px] text-[#626D80]">{readableSize(asset.bytes)}</span>
              <button
                type="button"
                onClick={() => void remove(asset.id)}
                aria-label={`Remove ${asset.name}`}
                className="shrink-0 rounded-full p-1.5 text-[#626D80] transition hover:bg-[#F1F3F6] hover:text-[#111827]"
              >
                <X aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {refusals.length > 0 ? (
        <ul className="space-y-1" role="alert">
          {refusals.map((message) => (
            <li key={message} className="text-[13.5px] font-medium text-[#B43A34]">
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
