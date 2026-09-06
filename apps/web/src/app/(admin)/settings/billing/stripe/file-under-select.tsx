"use client";

import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { LEAVE, NEW_CLIENT } from "./import-form";
import { useReviewForm } from "./review-form-state";

export interface FileUnderOption {
  id: string;
  name: string;
  /** Why it is suggested — core's display text, e.g. `Same email domain (…)`. */
  reason?: string | undefined;
}

/**
 * "File under" for one Stripe customer: create a client with the name shown,
 * or place the subscription under one we already have. The preview's email
 * match (when there is one) and its candidates come first, the rest of the
 * book alphabetically after; the name input only shows for the new-client
 * choice. A cancelled subscription with no match can only be filed under an
 * existing client or left out — the import never invents a client for a
 * relationship that has ended.
 *
 * No `name` on either control: the answer lives in `ReviewFormProvider`,
 * which posts it once (see there for why).
 */
export function FileUnderSelect({
  customerId, customerLabel, matched, candidates, clients, cancelled,
}: {
  customerId: string;
  /** Who this is, for the accessible name: the email, or the customer id. */
  customerLabel: string;
  matched: FileUnderOption | null;
  candidates: readonly FileUnderOption[];
  clients: readonly FileUnderOption[];
  cancelled: boolean;
}) {
  const { fileUnder, clientNames, setFileUnder, setClientName } = useReviewForm();
  const choice = fileUnder[customerId] ?? NEW_CLIENT;
  const suggested = new Set([matched?.id, ...candidates.map((c) => c.id)]);
  const rest = clients.filter((c) => !suggested.has(c.id));

  const hint = choice === NEW_CLIENT
    ? "Will create this client if its product is ticked"
    : choice === LEAVE
      ? "Cancelled and no client to file it under — not imported"
      : "Files under this client; the Stripe customer becomes one of its payment accounts";

  return (
    <div className="min-w-0 space-y-1">
      <NativeSelect
        value={choice}
        onChange={(event) => setFileUnder(customerId, event.target.value)}
        aria-label={`File under for ${customerLabel}`}
        className="min-w-48"
      >
        {cancelled && !matched ? <option value={LEAVE}>Leave it — not imported</option> : null}
        {!cancelled || matched ? <option value={NEW_CLIENT}>Create new client</option> : null}
        {matched ? <option value={matched.id}>{matched.name} — matched by email</option> : null}
        {candidates.length > 0 ? (
          <optgroup label="Suggested">
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.reason ? ` — ${c.reason.toLowerCase()}` : ""}</option>
            ))}
          </optgroup>
        ) : null}
        {rest.length > 0 ? (
          <optgroup label="All clients">
            {rest.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </optgroup>
        ) : null}
      </NativeSelect>
      {/* Kept mounted so a name typed before a change of mind survives; core reads it only for the new-client choice. */}
      <Input
        value={clientNames[customerId] ?? ""}
        onChange={(event) => setClientName(customerId, event.target.value)}
        maxLength={200}
        aria-label={`Client name for ${customerLabel}`}
        className="min-w-48"
        hidden={choice !== NEW_CLIENT}
      />
      <div className="text-meta text-muted-foreground">{hint}</div>
    </div>
  );
}
