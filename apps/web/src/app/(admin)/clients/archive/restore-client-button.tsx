"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { restoreClientAction } from "../actions";

/**
 * Restore is not destructive, so it does not ask twice. The only thing it has
 * to do is report its own failure rather than leave a row looking restored.
 */
export function RestoreClientButton({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await restoreClientAction({ clientId });
            if (result.status === "error") setError(result.message);
          })
        }
      >
        {pending ? "Restoring…" : "Restore"}
      </Button>
      {error ? (
        <p className="text-meta text-danger-fg" role="alert">
          {clientName}: {error}
        </p>
      ) : null}
    </div>
  );
}
