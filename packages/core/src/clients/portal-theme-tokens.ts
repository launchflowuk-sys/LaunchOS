/**
 * The portal's look, as plain data.
 *
 * Split from `portal-theme.ts` and given its own subpath export for one
 * reason: the picker is a **client component**, and importing the `core`
 * barrel from the browser drags `@launchos/db` and then `postgres` in with it,
 * which fails the build on a missing `net` module. Typecheck does not catch
 * it; `next build` does, at the end. `@launchos/core/queue` is split for the
 * same class of reason.
 *
 * Nothing here may import anything. That constraint is the whole point.
 */

export const PORTAL_ACCENTS = {
  /** LaunchFlow's own blue. What every client starts on. */
  default: { label: "LaunchFlow blue", hex: "#0969ca" },
  slate: { label: "Graphite", hex: "#334155" },
  teal: { label: "Teal", hex: "#0f766e" },
  violet: { label: "Violet", hex: "#6d28d9" },
  rose: { label: "Rose", hex: "#be123c" },
  amber: { label: "Amber", hex: "#b45309" },
  forest: { label: "Forest", hex: "#15803d" },
} as const;

export type PortalAccent = keyof typeof PORTAL_ACCENTS;

/**
 * The page behind the panels. Not a dark mode — the workspace is never
 * darkened — but a choice between a plain white sheet and a tinted one, which
 * is the difference between the portal reading as a document and as an app.
 */
export const PORTAL_SURFACES = {
  soft: { label: "Soft grey" },
  paper: { label: "White" },
} as const;

export type PortalSurface = keyof typeof PORTAL_SURFACES;

export interface PortalTheme {
  accent: PortalAccent;
  surface: PortalSurface;
}

export const PORTAL_THEME_DEFAULT: PortalTheme = { accent: "default", surface: "soft" };

/** The CSS custom properties a theme sets. One place, so the server and the live preview agree. */
export function portalThemeVars(theme: PortalTheme): Record<string, string> {
  const hex = PORTAL_ACCENTS[theme.accent].hex;
  return {
    "--primary": hex,
    // `color-mix` rather than a second stored colour: the tint is always the
    // accent, and two values that can disagree is a bug waiting to be filed.
    "--primary-soft": `color-mix(in oklab, ${hex} 10%, white)`,
    ...(theme.surface === "paper" ? { "--background": "#ffffff" } : {}),
  };
}
