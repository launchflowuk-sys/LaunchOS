import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  assertBootstrapAllowed,
  bootstrap,
  BootstrapGuardError,
  bootstrapInputFromEnv,
  CREDENTIAL_PROVIDER,
  describeDatabase,
  ensureOrganisation,
  ensureUserRow,
  organisationFromEnv,
} from "./bootstrap.js";
import { DEFAULT_CLIENT_PASSWORD, DEFAULT_OWNER_PASSWORD, MIN_PASSWORD_LENGTH } from "./passwords.js";
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

/** The shape `assertBootstrapAllowed` guards, with a slug that is confirmed by default. */
function guardInput(overrides: { organisationSlug?: string; ownerPassword?: string } = {}) {
  return {
    organisationSlug: overrides.organisationSlug ?? "acme",
    ownerPassword: overrides.ownerPassword ?? "a-real-long-password",
  };
}

const PRODUCTION = { NODE_ENV: "production", BOOTSTRAP_CONFIRM: "acme" };

describe("assertBootstrapAllowed", () => {
  describe("the password floor, in every environment", () => {
    const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    const atFloor = "x".repeat(MIN_PASSWORD_LENGTH);

    it("refuses a password one character under the floor, outside production", () => {
      expect(() => assertBootstrapAllowed(guardInput({ ownerPassword: short }), { NODE_ENV: "development" })).toThrow(
        /minimum is 12/,
      );
    });

    it("refuses a password one character under the floor, in production", () => {
      expect(() => assertBootstrapAllowed(guardInput({ ownerPassword: short }), PRODUCTION)).toThrow(/minimum is 12/);
    });

    it("allows a password exactly at the floor, outside production", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput({ ownerPassword: atFloor }), { NODE_ENV: "development" }),
      ).not.toThrow();
    });

    it("names the guard that refused", () => {
      try {
        assertBootstrapAllowed(guardInput({ ownerPassword: short }), { NODE_ENV: "development" });
        expect.unreachable("the floor guard should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(BootstrapGuardError);
        expect((error as BootstrapGuardError).guard).toBe("password-floor");
      }
    });

    it("holds the same floor the app enforces on everyone else", () => {
      // apps/web/src/lib/auth.ts: emailAndPassword.minPasswordLength.
      expect(MIN_PASSWORD_LENGTH).toBe(12);
    });
  });

  describe("the published defaults", () => {
    it("refuses the owner default in production", () => {
      expect(() => assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), PRODUCTION)).toThrow(
        /published in this repository/,
      );
    });

    it("refuses the client default in production", () => {
      expect(() => assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_CLIENT_PASSWORD }), PRODUCTION)).toThrow(
        /published in this repository/,
      );
    });

    it("allows the owner default outside production — it clears the floor", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), { NODE_ENV: "development" }),
      ).not.toThrow();
    });
  });

  describe("BOOTSTRAP_CONFIRM", () => {
    it("refuses in production when it is unset", () => {
      expect(() => assertBootstrapAllowed(guardInput(), { NODE_ENV: "production" })).toThrow(/BOOTSTRAP_CONFIRM/);
    });

    it("refuses in production when it does not match the slug", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput({ organisationSlug: "acme" }), {
          NODE_ENV: "production",
          BOOTSTRAP_CONFIRM: "acme-typo",
        }),
      ).toThrow(/"acme"/);
    });

    it("allows in production when it matches the slug", () => {
      expect(() => assertBootstrapAllowed(guardInput(), PRODUCTION)).not.toThrow();
    });

    it("is not required outside production", () => {
      expect(() => assertBootstrapAllowed(guardInput(), { NODE_ENV: "development" })).not.toThrow();
    });

    it("names the guard that refused", () => {
      try {
        assertBootstrapAllowed(guardInput(), { NODE_ENV: "production" });
        expect.unreachable("the confirm guard should have thrown");
      } catch (error) {
        expect((error as BootstrapGuardError).guard).toBe("confirm-slug");
      }
    });
  });
});

describe("describeDatabase", () => {
  it("prints the host and database, never the credentials", () => {
    const described = describeDatabase("postgres://launchos:s3cret@db.internal:5432/launchos");
    expect(described).toBe("db.internal:5432/launchos");
    expect(described).not.toContain("s3cret");
  });
});

describe("organisationFromEnv", () => {
  it("reads SEED_ORG_NAME and SEED_ORG_SLUG", () => {
    expect(organisationFromEnv({ SEED_ORG_NAME: "Acme", SEED_ORG_SLUG: "acme" } as NodeJS.ProcessEnv)).toEqual({
      name: "Acme",
      slug: "acme",
    });
  });

  it("defaults to LaunchFlow", () => {
    expect(organisationFromEnv({} as NodeJS.ProcessEnv)).toEqual({ name: "LaunchFlow", slug: "launchflow" });
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

  describe("on a pre-existing user", () => {
    it("keeps an existing account row rather than setting a password on it", async () => {
      await withTestDb(async (db) => {
        const input = inputFor(randomUUID());
        // A user who already has an account row of some other kind — an OAuth
        // link, say. The bootstrap must not attach a password to it.
        const user = await ensureUserRow(db, { email: input.ownerEmail, name: input.ownerName });
        await db.insert(schema.account).values({
          id: randomUUID(),
          accountId: "external-123",
          providerId: "github",
          issuer: "https://github.com",
          userId: user.row.id,
        });

        const result = await bootstrap(db, input);

        expect(result.userCreated).toBe(false);
        expect(result.passwordSet).toBe(false);
        const credentials = await db
          .select()
          .from(schema.account)
          .where(and(eq(schema.account.userId, user.row.id), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));
        expect(credentials).toHaveLength(0);
      });
    });

    it("refuses when the membership exists with a non-owner role, and writes no credential", async () => {
      await withTestDb(async (db) => {
        const input = inputFor(randomUUID());
        const organisation = await ensureOrganisation(db, {
          name: input.organisationName,
          slug: input.organisationSlug,
        });
        // Exactly what /team writes for an invited staff member: a membership,
        // and deliberately no credential until the one-time password is issued.
        const user = await ensureUserRow(db, { email: input.ownerEmail, name: input.ownerName });
        await db
          .insert(schema.organisationMembers)
          .values({ organisationId: organisation.row.id, userId: user.row.id, role: "staff", status: "invited" });

        await expect(bootstrap(db, input)).rejects.toThrow(/role "staff" and status "invited"/);

        const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, user.row.id));
        expect(accounts).toHaveLength(0);
      });
    });

    it("accepts an existing active owner membership", async () => {
      await withTestDb(async (db) => {
        const input = inputFor(randomUUID());
        const first = await bootstrap(db, input);
        const second = await bootstrap(db, input);
        expect(second.userId).toBe(first.userId);
      });
    });
  });
});
