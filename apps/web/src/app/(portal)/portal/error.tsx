"use client";

import { useEffect } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";

/**
 * Boundary for every portal screen. Next 16 passes `retry` (which re-fetches
 * the segment) rather than the older `reset`; see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`.
 *
 * Clients see even less than staff do: only the digest, never the message.
 * Raw errors can carry table names, query fragments or another tenant's ids.
 *
 * It keeps an `<h1>`: a page whose content failed still has to announce itself
 * to a screen reader, and the failure is the page.
 */
export default function PortalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("portal screen failed", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-title font-semibold">Something went wrong</h1>
      <p className="mt-2 text-base text-muted-foreground">
        This page could not be loaded. Trying again usually fixes it — nothing on your account has changed.
      </p>

      <div className="mt-5 max-sm:[&>*]:w-full">
        <Button type="button" size="lg" onClick={() => retry()}>
          Try again
        </Button>
      </div>

      {error.digest ? (
        <InlineAlert tone="info" className="mt-6">
          If it keeps happening, quote reference <span className="font-mono">{error.digest}</span> when you get in
          touch and we will find it in our logs.
        </InlineAlert>
      ) : null}
    </div>
  );
}
