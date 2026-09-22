import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";

/**
 * How a client's own portal looks to them.
 *
 * **A named set, not a colour picker.** A free hex field is one line of code
 * and a permanent accessibility problem: somebody picks their brand yellow,
 * the white text on every button disappears, and the portal is broken for the
 * one person who cannot report it to anybody but us. Each accent here has been
 * chosen to carry white text at the weight the buttons use, and the two
 * surface choices keep the same contrast in both.
 *
 * It is stored on the **client**, not the portal user. A business has a look;
 * its staff do not each have their own. Two people from the same firm seeing
 * different portals would also make every support conversation about what is
 * on screen harder than it needs to be.
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

/**
 * Parsed rather than trusted on the way **out** as well as in. The column is
 * jsonb, so a hand-edited row or a value written before an accent was renamed
 * would otherwise reach the page and set a CSS variable to whatever it says.
 */
export const PortalThemeSchema = z.object({
  accent: z.enum(Object.keys(PORTAL_ACCENTS) as [PortalAccent, ...PortalAccent[]]).default("default"),
  surface: z.enum(Object.keys(PORTAL_SURFACES) as [PortalSurface, ...PortalSurface[]]).default("soft"),
});

/** The stored theme, or the default. Never throws: a bad row falls back rather than breaking the portal. */
export function readPortalTheme(value: unknown): PortalTheme {
  const parsed = PortalThemeSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : PORTAL_THEME_DEFAULT;
}

/** One client's portal theme. */
export async function getPortalTheme(db: Db, organisationId: string, clientId: string): Promise<PortalTheme> {
  const [row] = await db
    .select({ theme: schema.clients.portalTheme })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.id, clientId)));
  return readPortalTheme(row?.theme);
}

export const SetPortalThemeInput = z.object({
  clientId: z.string().uuid(),
  theme: PortalThemeSchema,
  actorKind: z.enum(["user", "client", "agent", "system"]).default("client"),
  actorId: z.string().min(1).optional(),
});
export type SetPortalThemeInput = z.input<typeof SetPortalThemeInput>;

/**
 * Sets it, and records who did.
 *
 * Audited like any other write to a client record — not because the colour
 * matters, but because "the portal looks different and nobody knows why" is a
 * support call, and one line in the log answers it in seconds.
 */
export async function setPortalTheme(
  db: Db,
  organisationId: string,
  input: SetPortalThemeInput,
): Promise<PortalTheme> {
  const v = SetPortalThemeInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);

  const [before] = await db
    .select({ theme: schema.clients.portalTheme })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.id, v.clientId)));

  const [after] = await db
    .update(schema.clients)
    .set({ portalTheme: v.theme, updatedAt: new Date() })
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.id, v.clientId)))
    .returning({ theme: schema.clients.portalTheme });

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind,
    ...(v.actorId ? { actorId: v.actorId } : {}),
    action: "client.portal_theme_changed",
    targetType: "client",
    targetId: v.clientId,
    before: { theme: readPortalTheme(before?.theme) },
    after: { theme: readPortalTheme(after?.theme) },
  });

  return readPortalTheme(after?.theme);
}
