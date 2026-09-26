"use client";

import { useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { importFromEnvAction } from "./actions";

type Result = Awaited<ReturnType<typeof importFromEnvAction>> | null;

/** Local-only: reads the repo `.env`, so this button reports nothing in production. */
export function ImportEnvButton() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>(null);

  async function run() {
    setPending(true);
    try {
      setResult(await importFromEnvAction());
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" disabled={pending} onClick={() => void run()}>
        {pending ? "Importing…" : "Import from .env"}
      </Button>
      {result ? (
        <InlineAlert tone={result.failed.length > 0 ? "warning" : "success"}>
          {result.added.length} added, {result.skipped.length} skipped
          {result.failed.length > 0 ? `, ${result.failed.length} failed: ${result.failed.map((f) => `${f.label} (${f.message})`).join("; ")}` : ""}.
        </InlineAlert>
      ) : null}
    </div>
  );
}
