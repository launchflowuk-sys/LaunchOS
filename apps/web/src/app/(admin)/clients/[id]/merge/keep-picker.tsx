"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export interface KeepCandidate {
  id: string;
  name: string;
  email: string | null;
}

/**
 * Step one of a merge: which client survives. A plain GET form — the choice
 * lands in `?keep=` and the page renders the preview for it, so the confirm
 * screen has a URL of its own and Back returns here. The search box narrows
 * the native select rather than replacing it: a real `<select>` still posts
 * without JavaScript and is what the e2e drives.
 */
export function KeepClientPicker({ clients }: { clients: readonly KeepCandidate[] }) {
  const [query, setQuery] = useState("");
  const [keep, setKeep] = useState("");
  const searchId = useId();
  const keepId = useId();
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? clients.filter((c) => c.name.toLowerCase().includes(needle) || (c.email?.toLowerCase().includes(needle) ?? false))
    : clients;
  const keepStillShown = shown.some((c) => c.id === keep);

  return (
    <form method="get" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor={searchId}>Search clients</Label>
        <Input
          id={searchId}
          type="search"
          placeholder="Name or email"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={keepId}>Client to keep</Label>
        <NativeSelect id={keepId} name="keep" required value={keepStillShown ? keep : ""} onChange={(event) => setKeep(event.target.value)}>
          <option value="">{shown.length === 0 ? "No client matches" : "Choose a client…"}</option>
          {shown.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.email ? ` — ${c.email}` : ""}</option>
          ))}
        </NativeSelect>
      </div>
      <Button type="submit" disabled={!keepStillShown} className="max-sm:w-full">Continue</Button>
    </form>
  );
}
