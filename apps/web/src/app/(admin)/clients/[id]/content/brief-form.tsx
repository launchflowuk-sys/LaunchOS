import type { ContentBriefRow } from "@launchos/core";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveContentBriefAction } from "./actions";

type Field = { name: keyof Pick<ContentBriefRow, "tone" | "audience" | "services" | "offers" | "area" | "doNotSay" | "notes">; label: string; hint: string; rows?: number };

/** The questions the content writer needs answered, in the order it reads them. */
const FIELDS: readonly Field[] = [
  { name: "tone", label: "Tone of voice", hint: "Friendly and local? Plain and professional? Two or three words." },
  { name: "audience", label: "Who the posts are for", hint: "Families in Grays, landlords, commuters to Fenchurch Street…" },
  { name: "services", label: "Services to talk about", hint: "One per line. Only what the client actually offers.", rows: 4 },
  { name: "offers", label: "Offers and prices that may be mentioned", hint: "Leave blank if none — the writer never invents an offer.", rows: 3 },
  { name: "area", label: "Area served", hint: "Towns, postcodes, landmarks that belong in a local post." },
  { name: "doNotSay", label: "Never say", hint: "Competitor names, claims the client cannot back, words they dislike.", rows: 3 },
  { name: "notes", label: "Anything else", hint: "Opening hours, seasonal angles, the owner's name if posts should sign off.", rows: 3 },
];

/**
 * One form, the whole brief. Saving replaces every field — a blank box is
 * "nothing to say", not "leave the old answer" — so what is on screen is
 * exactly what the writer gets.
 */
export function BriefForm({ clientId, brief }: { clientId: string; brief: ContentBriefRow | undefined }) {
  return (
    <ActionForm action={saveContentBriefAction} ariaLabel="Content brief" success="Brief saved" className="grid gap-4 rounded-xl border bg-card p-4">
      <input type="hidden" name="clientId" value={clientId} />
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <div key={field.name} className={field.rows && field.rows > 2 ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
            <Label htmlFor={`brief-${field.name}`}>{field.label}</Label>
            <Textarea
              id={`brief-${field.name}`}
              name={field.name}
              rows={field.rows ?? 2}
              maxLength={4000}
              defaultValue={brief?.[field.name] ?? ""}
            />
            <p className="text-meta text-muted-foreground">{field.hint}</p>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button type="submit" className="max-sm:w-full">
          Save brief
        </Button>
      </div>
    </ActionForm>
  );
}
