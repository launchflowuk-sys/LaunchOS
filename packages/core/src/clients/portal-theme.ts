import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  PORTAL_ACCENTS, PORTAL_SURFACES, PORTAL_THEME_DEFAULT,
  type PortalAccent, type PortalSurface, type PortalTheme,
} from "./portal-theme-tokens.js";
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

export {
  PORTAL_ACCENTS, PORTAL_SURFACES, PORTAL_THEME_DEFAULT, portalThemeVars,
} from "./portal-theme-tokens.js";
export type { PortalAccent, PortalSurface, PortalTheme } from "./portal-theme-tokens.js";

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
