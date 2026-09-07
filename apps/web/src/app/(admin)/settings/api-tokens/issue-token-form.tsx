"use client";

import { useActionState, useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { issueTokenAction, type IssueTokenState } from "./actions";

const INITIAL: IssueTokenState = { status: "idle" };

/**
 * The scopes arrive as props rather than being imported here.
 *
 * `@launchos/core`'s barrel reaches `@launchos/channels`, which reaches
 * `web-push`, which requires node's `net` — so importing so much as a string
 * constant from it into a **client** component drags a node builtin into the
 * browser bundle and the page 500s. TypeScript cannot see this; only the
 * bundler can. The server component already holds core safely, so it hands
 * down the two fields this form actually needs.
 */
export interface ScopeChoice {
  readonly key: string;
  readonly label: string;
}

export function IssueTokenForm({ scopes }: { scopes: readonly ScopeChoice[] }) {
  const [state, formAction, pending] = useActionState(issueTokenAction, INITIAL);

  if (state.status === "issued") return <IssuedToken token={state.token} name={state.name} />;

  return (
    <form action={formAction} aria-label="Issue an API token" className="max-w-xl space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required maxLength={120} placeholder="Mr. Green — laptop" />
        <p className="text-meta text-muted-foreground">
          What holds it. You will want this when deciding which one to kill.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What it may read</legend>
        <p className="text-meta text-muted-foreground">
          Nothing ticked means the token can read nothing. Every one of these is read-only — no token can change anything.
        </p>
        <div className="space-y-2 pt-1">
          {scopes.map((scope) => (
            <label key={scope.key} className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" name={`scope.${scope.key}`} className="mt-0.5" />
              <span>{scope.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="expiresInDays">Expires after</Label>
        <Input id="expiresInDays" name="expiresInDays" type="number" min={0} max={3650} defaultValue={0} className="max-w-32" />
        <p className="text-meta text-muted-foreground">Days. Zero means it never expires.</p>
      </div>

      {state.status === "error" ? <InlineAlert tone="danger">{state.message}</InlineAlert> : null}

      <Button type="submit" disabled={pending}>{pending ? "Issuing…" : "Issue token"}</Button>
    </form>
  );
}

/**
 * The token, once.
 *
 * There is no way back to this screen: only the hash was stored, so if it is
 * lost the only remedy is to issue another and revoke this one. The copy says
 * so plainly rather than leaving it to be discovered.
 */
function IssuedToken({ token, name }: { token: string; name: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="max-w-xl space-y-4" data-testid="issued-token">
      <InlineAlert tone="success">
        <strong>{name}</strong> is live. Copy it now — this is the only time it will ever be shown.
      </InlineAlert>

      <code className="block rounded-md border bg-muted/40 p-3 font-mono text-meta break-all">{token}</code>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={() => {
            // `navigator.clipboard` is unavailable over plain HTTP and in some
            // embedded browsers. The token is on screen and selectable either
            // way, so a failure here changes nothing that matters.
            void navigator.clipboard?.writeText(token).then(() => setCopied(true)).catch(() => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy token"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => window.location.reload()}>Done</Button>
      </div>

      <p className="text-meta text-muted-foreground">
        Only a hash of it is stored. Nobody — including this page — can show it to you again. If you lose it, revoke it and
        issue another.
      </p>
    </div>
  );
}
