"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Boundary for every admin screen. Next 16 passes `retry` (which re-fetches
 * the segment) rather than the older `reset`; see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`.
 *
 * Only the digest is shown: raw messages can carry query fragments, table
 * names or provider responses, none of which belong on screen. The full error
 * goes to the server log.
 */
export default function AdminError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("admin screen failed", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg rounded-xl border bg-card p-6 text-center">
      <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This screen could not be loaded. Trying again usually fixes it; if it does not, the reference below identifies
        this failure in the server log.
      </p>
      <div className="mt-4 flex justify-center">
        <Button type="button" onClick={() => retry()}>
          Retry
        </Button>
      </div>
      {error.digest ? <p className="mt-4 text-meta text-muted-foreground">
          Reference <span className="font-mono">{error.digest}</span>
        </p> : null}
    </div>
  );
}
