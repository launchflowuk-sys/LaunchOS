import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  getPortalTheme, PORTAL_ACCENTS, PORTAL_THEME_DEFAULT, readPortalTheme, setPortalTheme,
} from "./portal-theme.js";

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `th-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: "Northgate Blinds", slug: `ng-${randomUUID()}`,
  }).returning();
  return { organisationId: org!.id, clientId: client!.id };
}

describe("readPortalTheme", () => {
  /**
   * The column is jsonb, so what comes back is whatever is in the row. Every
   * one of these used to be a way to put an arbitrary string into a CSS
   * variable on a live page.
   */
  it("falls back rather than trusting the row", () => {
    expect(readPortalTheme(null)).toEqual(PORTAL_THEME_DEFAULT);
    expect(readPortalTheme({})).toEqual(PORTAL_THEME_DEFAULT);
    expect(readPortalTheme({ accent: "not-a-colour" })).toEqual(PORTAL_THEME_DEFAULT);
    expect(readPortalTheme({ accent: "</style><script>" })).toEqual(PORTAL_THEME_DEFAULT);
    expect(readPortalTheme("teal")).toEqual(PORTAL_THEME_DEFAULT);
    expect(readPortalTheme({ accent: "teal", surface: "paper" })).toEqual({ accent: "teal", surface: "paper" });
    // A half-set value keeps the half that is valid.
    expect(readPortalTheme({ accent: "violet" })).toEqual({ accent: "violet", surface: "soft" });
  });

  /** Every accent must be a real hex colour, or the stylesheet it feeds is broken. */
  it("ships only usable colours", () => {
    for (const [key, accent] of Object.entries(PORTAL_ACCENTS)) {
      expect(accent.hex, key).toMatch(/^#[0-9a-f]{6}$/);
      expect(accent.label.length, key).toBeGreaterThan(2);
    }
  });
});

describe("setPortalTheme", () => {
  it("stores the choice and reads it back", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      expect(await getPortalTheme(db, f.organisationId, f.clientId)).toEqual(PORTAL_THEME_DEFAULT);

      const after = await setPortalTheme(db, f.organisationId, {
        clientId: f.clientId, theme: { accent: "forest", surface: "paper" }, actorKind: "client",
      });

      expect(after).toEqual({ accent: "forest", surface: "paper" });
      expect(await getPortalTheme(db, f.organisationId, f.clientId)).toEqual({ accent: "forest", surface: "paper" });
    });
  });

  /** "The portal looks different and nobody knows why" is a support call one log line answers. */
  it("records who changed it", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await setPortalTheme(db, f.organisationId, {
        clientId: f.clientId, theme: { accent: "rose", surface: "soft" }, actorKind: "client",
      });

      const audits = await db.select({ action: schema.auditLog.action, targetId: schema.auditLog.targetId })
        .from(schema.auditLog).where(eq(schema.auditLog.organisationId, f.organisationId));
      expect(audits.some((a) => a.action === "client.portal_theme_changed" && a.targetId === f.clientId)).toBe(true);
    });
  });

  it("refuses an accent that is not on the list", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await expect(setPortalTheme(db, f.organisationId, {
        clientId: f.clientId, theme: { accent: "hotpink" } as never,
      })).rejects.toThrow();
    });
  });

  /** A client in another organisation is not this organisation's to restyle. */
  it("will not touch another organisation's client", async () => {
    await withTestDb(async (db) => {
      const mine = await fixture(db);
      const theirs = await fixture(db);
      await expect(setPortalTheme(db, mine.organisationId, {
        clientId: theirs.clientId, theme: { accent: "teal", surface: "soft" },
      })).rejects.toThrow();

      // And theirs is untouched.
      const [row] = await db.select({ theme: schema.clients.portalTheme }).from(schema.clients)
        .where(and(eq(schema.clients.id, theirs.clientId), eq(schema.clients.organisationId, theirs.organisationId)));
      expect(readPortalTheme(row?.theme)).toEqual(PORTAL_THEME_DEFAULT);
    });
  });
});
