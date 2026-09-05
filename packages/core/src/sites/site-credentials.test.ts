import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { setEnqueue } from "../events/emit.js";
import { SecretsKeyError } from "../secrets/encryption.js";
import { createSite } from "./create-site.js";
import {
  getSiteCmsCredential,
  getSiteCmsCredentialStatus,
  setSiteCmsCredential,
  siteCredentialResolver,
} from "./site-credentials.js";

const ENV = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const APP_PASSWORD = "abcd EFGH 1234 ijkl MNOP 5678";

setEnqueue(async () => {});

async function fixture(db: Db, platform: "wordpress" | "nextjs" = "wordpress") {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const client = await createClient(db, org!.id, { name: "Acme" });
  const site = await createSite(db, org!.id, {
    clientId: client.id,
    name: "acme.test",
    primaryUrl: "https://acme.test",
    platform,
  });
  return { organisationId: org!.id, site };
}

describe("site CMS credentials", () => {
  it("stores the password as ciphertext, reads it back, and audits without it", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await fixture(db);

      const saved = await setSiteCmsCredential(
        db,
        organisationId,
        { siteId: site.id, username: "shoji", appPassword: APP_PASSWORD, actorKind: "user", actorId: "user-1" },
        ENV,
      );
      expect(saved.username).toBe("shoji");
      expect(JSON.stringify(saved)).not.toContain(APP_PASSWORD);

      const [row] = await db
        .select()
        .from(schema.siteCredentials)
        .where(eq(schema.siteCredentials.siteId, site.id));
      expect(row!.secretCiphertext.startsWith("v1.")).toBe(true);
      expect(row!.secretCiphertext).not.toContain(APP_PASSWORD);
      expect(row!.organisationId).toBe(organisationId);
      expect(row!.createdBy).toBe("user-1");

      expect(await getSiteCmsCredential(db, organisationId, site.id, ENV)).toEqual({
        username: "shoji",
        appPassword: APP_PASSWORD,
      });

      const [audit] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "site_credential.set"), eq(schema.auditLog.targetId, site.id)));
      expect(audit).toBeDefined();
      expect(audit!.actorId).toBe("user-1");
      expect(JSON.stringify(audit!.after)).toContain("shoji");
      expect(JSON.stringify(audit!.after)).not.toContain(APP_PASSWORD);
    });
  });

  it("replaces the credential in place when it is set again", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await fixture(db);
      const input = { siteId: site.id, username: "shoji", appPassword: "first one", actorKind: "user" as const };

      await setSiteCmsCredential(db, organisationId, input, ENV);
      await setSiteCmsCredential(db, organisationId, { ...input, username: "shoji2", appPassword: "second one" }, ENV);

      const rows = await db.select().from(schema.siteCredentials).where(eq(schema.siteCredentials.siteId, site.id));
      expect(rows).toHaveLength(1);
      expect(await getSiteCmsCredential(db, organisationId, site.id, ENV)).toEqual({
        username: "shoji2",
        appPassword: "second one",
      });
    });
  });

  it("reports status without decrypting, and reports nothing for an unconnected site", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await fixture(db);
      expect(await getSiteCmsCredentialStatus(db, organisationId, site.id)).toBeNull();
      expect(await getSiteCmsCredential(db, organisationId, site.id, ENV)).toBeNull();

      await setSiteCmsCredential(db, organisationId, { siteId: site.id, username: "shoji", appPassword: APP_PASSWORD }, ENV);

      const status = await getSiteCmsCredentialStatus(db, organisationId, site.id);
      expect(status!.username).toBe("shoji");
      expect(JSON.stringify(status)).not.toContain(APP_PASSWORD);
    });
  });

  it("refuses to write anything when the encryption key is unset", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await fixture(db);

      await expect(
        setSiteCmsCredential(db, organisationId, { siteId: site.id, username: "shoji", appPassword: APP_PASSWORD }, {}),
      ).rejects.toThrow(SecretsKeyError);

      const rows = await db.select().from(schema.siteCredentials).where(eq(schema.siteCredentials.siteId, site.id));
      expect(rows).toHaveLength(0);
    });
  });

  it("refuses a site in another organisation and a site that is not WordPress", async () => {
    await withTestDb(async (db) => {
      const a = await fixture(db);
      const b = await fixture(db);

      await expect(
        setSiteCmsCredential(db, a.organisationId, { siteId: b.site.id, username: "x", appPassword: "y" }, ENV),
      ).rejects.toThrow(/not found in organisation/);

      const nextjs = await fixture(db, "nextjs");
      await expect(
        setSiteCmsCredential(db, nextjs.organisationId, { siteId: nextjs.site.id, username: "x", appPassword: "y" }, ENV),
      ).rejects.toThrow(/recorded as nextjs/);
    });
  });

  it("resolves a live connection for the provider, and null when there is none", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await fixture(db);
      const resolve = siteCredentialResolver(db, organisationId, ENV);

      expect(await resolve(site.id)).toBeNull();
      expect(await resolve(crypto.randomUUID())).toBeNull();

      await setSiteCmsCredential(db, organisationId, { siteId: site.id, username: "shoji", appPassword: APP_PASSWORD }, ENV);

      expect(await resolve(site.id)).toEqual({
        baseUrl: "https://acme.test",
        platform: "wordpress",
        username: "shoji",
        appPassword: APP_PASSWORD,
      });
    });
  });
});
