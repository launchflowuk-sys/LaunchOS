import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  assertBootstrapAllowed,
  bootstrap,
  bootstrapInputFromEnv,
  CREDENTIAL_PROVIDER,
  DEFAULT_CLIENT_PASSWORD,
  DEFAULT_OWNER_PASSWORD,
} from "./bootstrap.js";
import * as schema from "./schema/index.js";
import { withTestDb } from "./test/db.js";

/** A unique organisation and owner per test: the seed's rows must not be touched. */
function inputFor(stamp: string) {
  return {
    organisationName: `Test Agency ${stamp}`,
    organisationSlug: `test-${stamp}`,
    ownerEmail: `owner.${stamp}@launchos.test`,
    ownerName: "Test Owner",
    ownerPassword: `real-password-${stamp}`,
  };
}

describe("assertBootstrapAllowed", () => {
  it("allows a default password outside production", () => {
    expect(() => assertBootstrapAllowed({ ownerPassword: DEFAULT_OWNER_PASSWORD }, "development")).not.toThrow();
  });

  it("refuses the published owner default in production", () => {
    expect(() => assertBootstrapAllowed({ ownerPassword: DEFAULT_OWNER_PASSWORD }, "production")).toThrow(
      /published in this repository/,
    );
  });

  it("refuses the published client default in production", () => {
    expect(() => assertBootstrapAllowed({ ownerPassword: DEFAULT_CLIENT_PASSWORD }, "production")).toThrow();
  });

  it("allows a real password in production", () => {
    expect(() => assertBootstrapAllowed({ ownerPassword: "a-real-one" }, "production")).not.toThrow();
  });
});

describe("bootstrapInputFromEnv", () => {
  it("reads the organisation and owner from SEED_* variables", () => {
    const input = bootstrapInputFromEnv({
      SEED_ORG_NAME: "Acme",
      SEED_ORG_SLUG: "acme",
      SEED_OWNER_EMAIL: "jo@acme.test",
      SEED_OWNER_NAME: "Jo",
      SEED_OWNER_PASSWORD: "secret",
    } as NodeJS.ProcessEnv);
    expect(input).toEqual({
      organisationName: "Acme",
      organisationSlug: "acme",
      ownerEmail: "jo@acme.test",
      ownerName: "Jo",
      ownerPassword: "secret",
    });
  });
});

describe("bootstrap", () => {
  it("creates the organisation, the owner and an owner membership", async () => {
    await withTestDb(async (db) => {
      const input = inputFor(randomUUID());

      const result = await bootstrap(db, input);

      expect(result.organisationCreated).toBe(true);
      expect(result.userCreated).toBe(true);
      expect(result.passwordSet).toBe(true);

      const [member] = await db
        .select()
        .from(schema.organisationMembers)
        .where(
          and(
            eq(schema.organisationMembers.organisationId, result.organisationId),
            eq(schema.organisationMembers.userId, result.userId),
          ),
        );
      expect(member?.role).toBe("owner");
      expect(member?.status).toBe("active");

      const [credential] = await db
        .select()
        .from(schema.account)
        .where(
          and(eq(schema.account.userId, result.userId), eq(schema.account.providerId, CREDENTIAL_PROVIDER)),
        );
      // Hashed, never the plaintext.
      expect(credential?.password).toBeTruthy();
      expect(credential?.password).not.toBe(input.ownerPassword);
    });
  });

  it("writes no demo data", async () => {
    await withTestDb(async (db) => {
      const result = await bootstrap(db, inputFor(randomUUID()));

      const clients = await db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.organisationId, result.organisationId));
      const enablement = await db
        .select()
        .from(schema.agentEnablement)
        .where(eq(schema.agentEnablement.organisationId, result.organisationId));
      const invoices = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.organisationId, result.organisationId));

      expect(clients).toHaveLength(0);
      expect(enablement).toHaveLength(0);
      expect(invoices).toHaveLength(0);
    });
  });

  it("is idempotent and never rewrites an existing password", async () => {
    await withTestDb(async (db) => {
      const input = inputFor(randomUUID());
      const first = await bootstrap(db, input);
      const [before] = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, first.userId), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));

      const second = await bootstrap(db, { ...input, ownerPassword: "a-different-password" });

      expect(second.organisationId).toBe(first.organisationId);
      expect(second.userId).toBe(first.userId);
      expect(second.organisationCreated).toBe(false);
      expect(second.userCreated).toBe(false);
      expect(second.passwordSet).toBe(false);

      const [after] = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, first.userId), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));
      expect(after?.password).toBe(before?.password);

      const members = await db
        .select()
        .from(schema.organisationMembers)
        .where(eq(schema.organisationMembers.organisationId, first.organisationId));
      expect(members).toHaveLength(1);
    });
  });
});
