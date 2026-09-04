"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Boundary for every portal screen. Next 16 passes `retry` (which re-fetches
 * the segment) rather than the older `reset`; see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`.
 *
 * Clients see even less than staff do: only the digest, never the message.
 * Raw errors can carry table names, query fragments or another tenant's ids.
 */
export default function PortalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("portal screen failed", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-6 text-center">
      <h1 className="text-base font-semibold text-neutral-900">Something went wrong</h1>
      <p className="mt-2 text-sm text-neutral-500">
        This page could not be loaded. Trying again usually fixes it. If it does not, quote the reference below when you
        get in touch and we will find it in our logs.
      </p>
      <div className="mt-4 flex justify-center">
        <Button type="button" onClick={() => retry()}>
          Retry
        </Button>
      </div>
      {error.digest ? <p className="mt-4 text-xs text-neutral-400">Reference {error.digest}</p> : null}
    </div>
  );
}
