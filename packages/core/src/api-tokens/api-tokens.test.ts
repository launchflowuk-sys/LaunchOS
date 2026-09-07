import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { issueApiToken } from "./issue-api-token.js";
import { verifyApiToken } from "./verify-api-token.js";
import { listApiTokens } from "./list-api-tokens.js";
import { revokeApiToken } from "./revoke-api-token.js";
import { bearerFrom, generateApiToken, hashApiToken, looksLikeApiToken } from "./token.js";

/** Audit rows this organisation wrote about tokens. Scoped, because the dev seed shares the database. */
async function tokenAudit(db: Parameters<Parameters<typeof withTestDb>[0]>[0], organisationId: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.targetType, "api_token")));
}

describe("the token itself", () => {
  it("carries a recognisable prefix, so a leaked one can be found by a scanner", () => {
    const { token, prefix } = generateApiToken();
    expect(token.startsWith("los_")).toBe(true);
    expect(prefix.startsWith("los_")).toBe(true);
    expect(looksLikeApiToken(token)).toBe(true);
  });

  it("shows only enough to recognise a row, never enough to use one", () => {
    const { token, prefix } = generateApiToken();
    expect(prefix.length).toBeLessThan(token.length / 2);
    expect(token.startsWith(prefix)).toBe(true);
  });

  it("is different every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateApiToken().token));
    expect(tokens.size).toBe(50);
  });

  it("hashes to the same value twice and to a different one for a different token", () => {
    expect(hashApiToken("los_abc")).toBe(hashApiToken("los_abc"));
    expect(hashApiToken("los_abc")).not.toBe(hashApiToken("los_abd"));
    expect(hashApiToken("los_abc")).toHaveLength(64);
  });

  it.each([
    ["a session cookie's value", "eyJhbGciOiJIUzI1NiJ9.abc"],
    ["another system's bearer", "ghp_0123456789"],
    ["the prefix with nothing after it", "los_"],
    ["nothing at all", ""],
  ])("does not send %s to the database", (_label, value) => {
    expect(looksLikeApiToken(value)).toBe(false);
  });

  it.each([
    ["Bearer los_abc", "los_abc"],
    ["bearer los_abc", "los_abc"],
    ["BEARER   los_abc  ", "los_abc"],
    ["  Bearer los_abc", "los_abc"],
  ])("reads %s as a bearer, case and spacing being the client's business", (header, expected) => {
    expect(bearerFrom(header)).toBe(expected);
  });

  it.each([[null], [""], ["Basic abc"], ["los_abc"], ["Bearer"], ["Bearer   "]])("reads %s as no bearer at all", (header) => {
    expect(bearerFrom(header)).toBeNull();
  });
});

describe("issuing", () => {
  it("returns the token once and stores only its hash", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, organisationId, { name: "Mr. Green — laptop", scopes: ["support"], actorId: ownerUserId });

      expect(issued.token.startsWith("los_")).toBe(true);
      const [row] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, issued.id));
      expect(row!.tokenHash).toBe(hashApiToken(issued.token));
      // The token is nowhere in the row that describes it.
      expect(JSON.stringify(row)).not.toContain(issued.token);
    });
  });

  it("keeps the token out of the audit log, which is read by more people and kept for longer", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, organisationId, { name: "Mr. Green", actorId: ownerUserId });

      const rows = await tokenAudit(db, organisationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("api_token.issued");
      const serialised = JSON.stringify(rows[0]);
      expect(serialised).not.toContain(issued.token);
      expect(serialised).not.toContain(hashApiToken(issued.token));
      // It does say enough to know which token this was about.
      expect(serialised).toContain(issued.prefix);
    });
  });

  it("refuses a token with no name, because a list of unnamed keys cannot be pruned", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      await expect(issueApiToken(db, organisationId, { name: "   " })).rejects.toThrow();
    });
  });

  it("records the scopes it was given and defaults to none", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const scoped = await issueApiToken(db, organisationId, { name: "billing reader", scopes: ["billing", "support"] });
      const bare = await issueApiToken(db, organisationId, { name: "nothing" });
      expect(scoped.scopes).toEqual(["billing", "support"]);
      expect(bare.scopes).toEqual([]);
    });
  });
});

describe("verifying", () => {
  it("turns a token into the organisation it speaks for", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, organisationId, { name: "Mr. Green", scopes: ["support"] });

      const verified = await verifyApiToken(db, issued.token);
      expect(verified).toMatchObject({ organisationId, tokenId: issued.id, name: "Mr. Green", scopes: ["support"] });
    });
  });

  it("stamps last used, so a forgotten key is visibly disposable", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, organisationId, { name: "Mr. Green" });
      expect((await listApiTokens(db, organisationId))[0]!.lastUsedAt).toBeNull();

      await verifyApiToken(db, issued.token);
      expect((await listApiTokens(db, organisationId))[0]!.lastUsedAt).toBeInstanceOf(Date);
    });
  });

  it("does not write a row per request for a column nobody reads to the second", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, organisationId, { name: "Mr. Green" });

      await verifyApiToken(db, issued.token);
      const first = (await listApiTokens(db, organisationId))[0]!.lastUsedAt;
      await verifyApiToken(db, issued.token);
      expect((await listApiTokens(db, organisationId))[0]!.lastUsedAt).toEqual(first);

      // An hour later it is worth writing again.
      await verifyApiToken(db, issued.token, new Date(Date.now() + 3_600_000));
      expect((await listApiTokens(db, organisationId))[0]!.lastUsedAt).not.toEqual(first);
    });
  });

  it("refuses a revoked token", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, organisationId, { name: "Mr. Green" });
      expect(await verifyApiToken(db, issued.token)).not.toBeNull();

      await revokeApiToken(db, organisationId, { id: issued.id, actorId: ownerUserId });
      expect(await verifyApiToken(db, issued.token)).toBeNull();
    });
  });

  it("refuses an expired token, and honours one that has not expired yet", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, organisationId, { name: "temporary", expiresAt: new Date(Date.now() + 60_000) });

      expect(await verifyApiToken(db, issued.token)).not.toBeNull();
      expect(await verifyApiToken(db, issued.token, new Date(Date.now() + 120_000))).toBeNull();
    });
  });

  it.each([
    ["one that was never issued", generateApiToken().token],
    ["a bearer from somewhere else", "ghp_something_else_entirely"],
    ["an empty string", ""],
  ])("refuses %s", async (_label, token) => {
    await withTestDb(async (db) => {
      await seedOrgWithClient(db);
      expect(await verifyApiToken(db, token)).toBeNull();
    });
  });

  it("cannot be made to answer for another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, a.organisationId, { name: "A's key" });

      const verified = await verifyApiToken(db, issued.token);
      expect(verified!.organisationId).toBe(a.organisationId);
      expect(verified!.organisationId).not.toBe(b.organisationId);
    });
  });
});

describe("listing and revoking", () => {
  it("lists newest first", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const older = await issueApiToken(db, organisationId, { name: "older" });
      await issueApiToken(db, organisationId, { name: "newer" });
      // Both rows share a timestamp — `now()` is the transaction's, not the
      // statement's — so age has to be made real before it can be asserted on.
      await db
        .update(schema.apiTokens)
        .set({ createdAt: new Date(Date.now() - 86_400_000) })
        .where(eq(schema.apiTokens.id, older.id));

      expect((await listApiTokens(db, organisationId)).map((r) => r.name)).toEqual(["newer", "older"]);
    });
  });

  it("does not reshuffle two tokens issued in the same breath", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      await issueApiToken(db, organisationId, { name: "first" });
      await issueApiToken(db, organisationId, { name: "second" });

      // Identical `created_at`, so the tiebreak is the only thing keeping the
      // order stable. Without it this list moves between reloads.
      const once = (await listApiTokens(db, organisationId)).map((r) => r.name);
      const twice = (await listApiTokens(db, organisationId)).map((r) => r.name);
      expect(once).toEqual(twice);
      expect(once).toHaveLength(2);
    });
  });

  it("never exposes the hash", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      await issueApiToken(db, organisationId, { name: "Mr. Green" });
      expect(JSON.stringify(await listApiTokens(db, organisationId))).not.toMatch(/[0-9a-f]{64}/);
    });
  });

  it("keeps a revoked token in the list, because the question is usually whether it is already dead", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, organisationId, { name: "Mr. Green" });
      await revokeApiToken(db, organisationId, { id: issued.id });

      const rows = await listApiTokens(db, organisationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
      expect(rows[0]!.active).toBe(false);
    });
  });

  it("marks an expired token inactive without anyone having revoked it", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      await issueApiToken(db, organisationId, { name: "temporary", expiresAt: new Date(Date.now() + 60_000) });

      expect((await listApiTokens(db, organisationId))[0]!.active).toBe(true);
      expect((await listApiTokens(db, organisationId, new Date(Date.now() + 120_000)))[0]!.active).toBe(false);
    });
  });

  it("shows one organisation only its own tokens", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await issueApiToken(db, a.organisationId, { name: "A's key" });

      expect(await listApiTokens(db, a.organisationId)).toHaveLength(1);
      expect(await listApiTokens(db, b.organisationId)).toHaveLength(0);
    });
  });

  it("will not let one organisation revoke another's token", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, a.organisationId, { name: "A's key" });

      expect(await revokeApiToken(db, b.organisationId, { id: issued.id })).toBe(false);
      // Still works, and B's attempt is not written into A's history.
      expect(await verifyApiToken(db, issued.token)).not.toBeNull();
      expect((await tokenAudit(db, a.organisationId)).filter((r) => r.action === "api_token.revoked")).toHaveLength(0);
    });
  });

  it("revoking twice is not an error and does not audit twice", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const issued = await issueApiToken(db, organisationId, { name: "Mr. Green" });

      expect(await revokeApiToken(db, organisationId, { id: issued.id })).toBe(true);
      expect(await revokeApiToken(db, organisationId, { id: issued.id })).toBe(false);
      expect((await tokenAudit(db, organisationId)).filter((r) => r.action === "api_token.revoked")).toHaveLength(1);
    });
  });
});
