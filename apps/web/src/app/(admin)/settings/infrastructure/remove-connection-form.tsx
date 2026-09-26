"use client";

import { Button } from "@/components/ui/button";
import { removeConnectionAction } from "./actions";

/** A confirm dialog needs a client component — a server component cannot pass an event handler to a DOM element. */
export function RemoveConnectionForm({ id, label }: { id: string; label: string }) {
  return (
    <form
      action={removeConnectionAction}
      onSubmit={(event) => {
        if (!window.confirm(`Remove "${label}"? This does not touch anything at the provider.`)) event.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="destructive-quiet" size="sm">Remove</Button>
    </form>
  );
}
