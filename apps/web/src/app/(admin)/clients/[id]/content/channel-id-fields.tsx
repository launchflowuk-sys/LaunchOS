"use client";

import { useState, useTransition } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { detectInstagramAction, findGbpLocationsAction } from "./actions";

/**
 * The Instagram id field with "Detect from Facebook page". The Page id is
 * read from the Facebook row's input by id — the two rows are separate
 * forms so one save cannot re-post the other — and falls back to the Page
 * id already saved. A hit fills the field and names the @handle; a Page
 * with no linked account, or a deployment without Meta keys, says so in a
 * sentence under the button rather than in a toast.
 */
export function InstagramIdField({
  fieldId,
  defaultValue,
  facebookFieldId,
  savedPageId,
  metaConfigured,
  label,
  placeholder,
  hint,
}: {
  fieldId: string;
  defaultValue: string;
  facebookFieldId: string;
  savedPageId: string | null;
  metaConfigured: boolean;
  label: string;
  placeholder: string;
  hint: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [note, setNote] = useState<{ tone: "success" | "info" | "danger"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function detect() {
    const live = (document.getElementById(facebookFieldId) as HTMLInputElement | null)?.value.trim();
    const pageId = live || savedPageId || "";
    if (!pageId) {
      setNote({ tone: "info", text: "Enter the Facebook Page id in the Facebook row first." });
      return;
    }
    startTransition(async () => {
      const result = await detectInstagramAction({ pageId });
      if (result.status === "found") {
        setValue(result.id);
        setNote({ tone: "success", text: result.username ? `Found @${result.username} — save to connect it.` : "Found the account — save to connect it." });
      } else if (result.status === "none") {
        setNote({ tone: "info", text: "That Page has no Instagram professional account linked. Link one in Meta Business Suite, then try again." });
      } else {
        setNote({ tone: "danger", text: result.message });
      }
    });
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id={fieldId} name="externalId" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} required />
        <Button type="button" variant="secondary" size="md" className="shrink-0" loading={pending} onClick={detect}>
          Detect from Facebook page
        </Button>
      </div>
      {!metaConfigured ? (
        <p className="text-meta text-muted-foreground">Waiting for Meta access — detection works once the Meta keys are set.</p>
      ) : null}
      {note ? (
        <InlineAlert tone={note.tone} className="mt-2">
          {note.text}
        </InlineAlert>
      ) : (
        <p className="text-meta text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

type Location = { name: string; title: string; accountName: string };

/**
 * The Business Profile location field with "Find my locations": lists what
 * the connected Google account manages and lets the operator pick one, which
 * fills the field with the exact resource name core stores. Without the GBP
 * keys the button is replaced by the honest line — Google's API access is
 * an application, not a setting.
 */
export function GbpLocationField({
  fieldId,
  defaultValue,
  gbpConfigured,
  label,
  placeholder,
  hint,
}: {
  fieldId: string;
  defaultValue: string;
  gbpConfigured: boolean;
  label: string;
  placeholder: string;
  hint: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [note, setNote] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function find() {
    startTransition(async () => {
      const result = await findGbpLocationsAction();
      if (result.status === "found") {
        setLocations(result.locations);
        setNote(result.locations.length === 0 ? { tone: "info", text: "The connected Google account manages no locations yet." } : null);
        if (result.locations.length === 1) setValue(result.locations[0]!.name);
      } else if (result.status === "unavailable") {
        setNote({ tone: "info", text: "Waiting for Google API access." });
      } else {
        setNote({ tone: "danger", text: result.message });
      }
    });
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id={fieldId} name="externalId" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} required />
        {gbpConfigured ? (
          <Button type="button" variant="secondary" size="md" className="shrink-0" loading={pending} onClick={find}>
            Find my locations
          </Button>
        ) : null}
      </div>
      {locations && locations.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-pick`}>Choose a location</Label>
          <NativeSelect id={`${fieldId}-pick`} value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Choose…</option>
            {locations.map((location) => (
              <option key={location.name} value={location.name}>
                {location.title} — {location.accountName}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      {!gbpConfigured ? (
        <p className="text-meta text-muted-foreground">Waiting for Google API access — until then, paste the location resource name.</p>
      ) : null}
      {note ? (
        <InlineAlert tone={note.tone} className="mt-2">
          {note.text}
        </InlineAlert>
      ) : (
        <p className="text-meta text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
