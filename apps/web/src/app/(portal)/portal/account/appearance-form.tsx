"use client";

// The tokens subpath, not the `core` barrel: this is a client component, and
// the barrel drags `@launchos/db` and `postgres` into the browser bundle.
import { PORTAL_ACCENTS, PORTAL_SURFACES, portalThemeVars, type PortalTheme } from "@launchos/core/portal-theme";
import { Check } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { savePortalThemeAction } from "./actions";

/**
 * The client's own choice of how their portal looks.
 *
 * Swatches rather than a colour input, because the accents are a fixed set
 * chosen to carry white text — see `portal-theme` in core for why that is not
 * a limitation worth removing.
 *
 * The preview is the page itself: choosing an accent sets the CSS variables on
 * `document.documentElement` straight away, so the buttons, links and tiles all
 * around this form change under the cursor. Saving then makes it permanent.
 * Nothing is written until Save, and leaving without saving reloads the stored
 * theme, so an experiment costs nothing.
 */
export function AppearanceForm({ initial }: { initial: PortalTheme }) {
  const [theme, setTheme] = useState<PortalTheme>(initial);
  const [saved, setSaved] = useState<PortalTheme>(initial);
  const [pending, startTransition] = useTransition();

  const dirty = theme.accent !== saved.accent || theme.surface !== saved.surface;

  /** Paints the choice on the live page so the swatch is a preview, not a promise. */
  function preview(next: PortalTheme) {
    setTheme(next);
    const root = document.documentElement;
    const vars = portalThemeVars(next);
    root.style.setProperty("--primary", vars["--primary"]!);
    root.style.setProperty("--primary-soft", vars["--primary-soft"]!);
    // Cleared rather than set, so "soft" falls back to the stylesheet's own value.
    root.style.setProperty("--background", vars["--background"] ?? "");
  }

  function save() {
    startTransition(async () => {
      const result = await savePortalThemeAction(theme);
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      setSaved(theme);
      toast.success("Saved. Your portal will look like this from now on.");
    });
  }

  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="text-row font-medium">Accent colour</legend>
        <p className="mt-0.5 text-meta text-muted-foreground">Used for buttons, links and highlights.</p>
        <div className="mt-3 flex flex-wrap gap-2.5">
          {Object.entries(PORTAL_ACCENTS).map(([key, accent]) => {
            const active = theme.accent === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => preview({ ...theme, accent: key as PortalTheme["accent"] })}
                aria-pressed={active}
                aria-label={accent.label}
                title={accent.label}
                className={cn(
                  "flex size-11 items-center justify-center rounded-full ring-offset-2 transition",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "ring-2 ring-foreground" : "ring-1 ring-border hover:ring-foreground/40",
                )}
                style={{ backgroundColor: accent.hex }}
              >
                {active ? <Check aria-hidden strokeWidth={3} className="size-5 text-white" /> : null}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-row font-medium">Background</legend>
        <p className="mt-0.5 text-meta text-muted-foreground">The page behind your panels.</p>
        <div className="mt-3 flex flex-wrap gap-2.5">
          {Object.entries(PORTAL_SURFACES).map(([key, surface]) => {
            const active = theme.surface === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => preview({ ...theme, surface: key as PortalTheme["surface"] })}
                aria-pressed={active}
                className={cn(
                  "rounded-xl border px-4 py-2.5 text-row transition",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-foreground font-medium" : "hover:border-foreground/40",
                )}
              >
                {surface.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={!dirty} loading={pending}>
          Save appearance
        </Button>
        {dirty ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => preview(saved)}
            disabled={pending}
          >
            Undo
          </Button>
        ) : null}
        <p className="text-meta text-muted-foreground">
          {dirty ? "Previewing — not saved yet." : "This is what everyone at your business sees."}
        </p>
      </div>
    </div>
  );
}
