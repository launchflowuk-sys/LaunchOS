"use client";

import { useId, useState } from "react";
import Markdown from "react-markdown";
import { Button } from "@/components/ui/button";

/**
 * Textarea plus preview. The textarea keeps its own `name`, so the enclosing
 * server-action form posts it like any other field and the page needs no
 * client-side submit handler.
 *
 * `react-markdown` renders text, not HTML, and no `rehype-raw` plugin is added,
 * so an article body stays inert however it was written.
 */
export function MarkdownEditor({
  name,
  label,
  defaultValue = "",
  rows = 18,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  rows?: number;
}) {
  const id = useId();
  const [value, setValue] = useState(defaultValue);
  const [preview, setPreview] = useState(false);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-neutral-700">
        {label}
      </label>
      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
          <Button type="button" size="sm" variant={preview ? "secondary" : "primary"} onClick={() => setPreview(false)}>
            Write
          </Button>
          <Button type="button" size="sm" variant={preview ? "primary" : "secondary"} onClick={() => setPreview(true)}>
            Preview
          </Button>
          <span className="ml-auto text-xs text-neutral-400">Markdown</span>
        </div>
        {/* The textarea stays mounted while previewing: unmounting it would drop
            the field from the form and the browser would post nothing. It also
            drops `required` while hidden, because a browser cannot focus a
            display:none control to report a validation message on it — the
            server validates the body either way. */}
        <div className={preview ? "hidden" : undefined}>
          <textarea
            id={id}
            name={name}
            rows={rows}
            required={!preview}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-full resize-y rounded-b-lg px-3 py-2 font-mono text-sm text-neutral-900 focus:outline-none"
          />
        </div>
        {preview ? (
          <div className="prose prose-sm max-w-none p-4 text-neutral-800">
            <Markdown>{value || "_Nothing to preview yet._"}</Markdown>
          </div>
        ) : null}
      </div>
    </div>
  );
}
