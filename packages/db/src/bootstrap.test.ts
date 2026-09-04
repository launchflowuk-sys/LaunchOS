import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  loadRootEnv,
  organisationFromEnv,
  ownerPasswordSource,
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

const LOCAL_URL = "postgres://launchos:launchos@localhost:5432/launchos";
const REMOTE_URL = "postgres://launchos:s3cret@db.launchflow.co.uk:5432/launchos";

/** A local target with NODE_ENV set: the guards that only run in production must not fire. */
const LOCAL = { NODE_ENV: "development", DATABASE_URL: LOCAL_URL };
/** NODE_ENV=production forces production on even when the host is local. */
const PRODUCTION = { NODE_ENV: "production", DATABASE_URL: LOCAL_URL, BOOTSTRAP_CONFIRM: "acme" };
/** Nobody exported NODE_ENV — the host is what makes this a production run. */
const REMOTE_NO_NODE_ENV = { DATABASE_URL: REMOTE_URL, BOOTSTRAP_CONFIRM: "acme" };

describe("assertBootstrapAllowed", () => {
  describe("the password floor, in every environment", () => {
    const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    const atFloor = "x".repeat(MIN_PASSWORD_LENGTH);

    it("refuses a password one character under the floor, outside production", () => {
      expect(() => assertBootstrapAllowed(guardInput({ ownerPassword: short }), LOCAL)).toThrow(/minimum is 12/);
    });

    it("refuses a password one character under the floor, in production", () => {
      expect(() => assertBootstrapAllowed(guardInput({ ownerPassword: short }), PRODUCTION)).toThrow(/minimum is 12/);
    });

    it("allows a password exactly at the floor, outside production", () => {
      expect(() => assertBootstrapAllowed(guardInput({ ownerPassword: atFloor }), LOCAL)).not.toThrow();
    });

    it("names the guard that refused", () => {
      try {
        assertBootstrapAllowed(guardInput({ ownerPassword: short }), LOCAL);
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

  describe("the slug, in every environment", () => {
    it("refuses a slug that is set but empty", () => {
      try {
        assertBootstrapAllowed(guardInput({ organisationSlug: "" }), LOCAL);
        expect.unreachable("the slug guard should have thrown");
      } catch (error) {
        expect((error as BootstrapGuardError).guard).toBe("organisation-slug");
        expect((error as Error).message).toMatch(/set but empty/);
      }
    });

    it("refuses an empty slug even when BOOTSTRAP_CONFIRM is equally empty", () => {
      // The `.env.example` paste: SEED_ORG_SLUG cleared, BOOTSTRAP_CONFIRM
      // shipped empty. Two empty strings used to compare equal and pass.
      expect(() =>
        assertBootstrapAllowed(guardInput({ organisationSlug: "" }), {
          NODE_ENV: "production",
          DATABASE_URL: LOCAL_URL,
          BOOTSTRAP_CONFIRM: "",
        }),
      ).toThrow(/set but empty/);
    });

    it("refuses a slug that is not slug-shaped", () => {
      expect(() => assertBootstrapAllowed(guardInput({ organisationSlug: "Acme Ltd" }), LOCAL)).toThrow(
        /not a valid slug/,
      );
      expect(() => assertBootstrapAllowed(guardInput({ organisationSlug: "-acme" }), LOCAL)).toThrow(
        /not a valid slug/,
      );
      expect(() => assertBootstrapAllowed(guardInput({ organisationSlug: "a" }), LOCAL)).toThrow(/not a valid slug/);
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
      expect(() => assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), LOCAL)).not.toThrow();
    });
  });

  describe("the production predicate is the database, not just NODE_ENV", () => {
    it("refuses the published default against a remote host with NODE_ENV unset", () => {
      try {
        assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), REMOTE_NO_NODE_ENV);
        expect.unreachable("a remote target must be treated as production");
      } catch (error) {
        expect((error as BootstrapGuardError).guard).toBe("published-default");
        expect((error as Error).message).toMatch(/not a local host/);
      }
    });

    it("requires BOOTSTRAP_CONFIRM against a remote host with NODE_ENV unset", () => {
      expect(() => assertBootstrapAllowed(guardInput(), { DATABASE_URL: REMOTE_URL })).toThrow(/BOOTSTRAP_CONFIRM/);
    });

    it("treats a missing DATABASE_URL as production", () => {
      expect(() => assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), {})).toThrow(
        /published in this repository/,
      );
    });

    it("allows the published default against localhost with NODE_ENV unset", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), { DATABASE_URL: LOCAL_URL }),
      ).not.toThrow();
    });

    it("allows the published default against the compose service name and a private address", () => {
      for (const host of ["postgres", "db", "127.0.0.1", "10.0.1.7", "172.20.0.3", "192.168.1.9"]) {
        expect(() =>
          assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), {
            DATABASE_URL: `postgres://u:p@${host}:5432/launchos`,
          }),
        ).not.toThrow();
      }
    });
  });

  describe("BOOTSTRAP_CONFIRM", () => {
    it("refuses in production when it is unset", () => {
      expect(() => assertBootstrapAllowed(guardInput(), { NODE_ENV: "production", DATABASE_URL: LOCAL_URL })).toThrow(
        /BOOTSTRAP_CONFIRM/,
      );
    });

    it("refuses in production when it is empty", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput(), {
          NODE_ENV: "production",
          DATABASE_URL: LOCAL_URL,
          BOOTSTRAP_CONFIRM: "   ",
        }),
      ).toThrow(/unset or empty/);
    });

    it("refuses in production when it does not match the slug", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput({ organisationSlug: "acme" }), {
          NODE_ENV: "production",
          DATABASE_URL: LOCAL_URL,
          BOOTSTRAP_CONFIRM: "acme-typo",
        }),
      ).toThrow(/"acme"/);
    });

    it("allows in production when it matches the slug", () => {
      expect(() => assertBootstrapAllowed(guardInput(), PRODUCTION)).not.toThrow();
    });

    it("accepts a confirmation with stray whitespace around the right slug", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput(), {
          NODE_ENV: "production",
          DATABASE_URL: LOCAL_URL,
          BOOTSTRAP_CONFIRM: " acme ",
        }),
      ).not.toThrow();
    });

    it("is not required outside production", () => {
      expect(() => assertBootstrapAllowed(guardInput(), LOCAL)).not.toThrow();
    });

    it("names the guard that refused", () => {
      try {
        assertBootstrapAllowed(guardInput(), { NODE_ENV: "production", DATABASE_URL: LOCAL_URL });
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

  it("trims, so a pasted trailing space cannot make a second organisation", () => {
    expect(organisationFromEnv({ SEED_ORG_SLUG: " launchflow " } as NodeJS.ProcessEnv).slug).toBe("launchflow");
    expect(organisationFromEnv({ SEED_ORG_NAME: "  Acme  " } as NodeJS.ProcessEnv).name).toBe("Acme");
  });

  it("keeps a set-but-empty slug empty, for the guard to refuse", () => {
    expect(organisationFromEnv({ SEED_ORG_SLUG: "   " } as NodeJS.ProcessEnv).slug).toBe("");
  });

  it("falls back to the default name when SEED_ORG_NAME is set but empty", () => {
    expect(organisationFromEnv({ SEED_ORG_NAME: " " } as NodeJS.ProcessEnv).name).toBe("LaunchFlow");
  });
});

describe("ownerPasswordSource", () => {
  it("names the variable when it was set", () => {
    expect(ownerPasswordSource({ SEED_OWNER_PASSWORD: "a-real-password" } as NodeJS.ProcessEnv)).toBe(
      "set from SEED_OWNER_PASSWORD",
    );
  });

  it("says so when the value came from the built-in default", () => {
    // The line an operator reads to confirm their password took. It must not
    // claim a variable that was never read.
    expect(ownerPasswordSource({} as NodeJS.ProcessEnv)).toMatch(/built-in default \(SEED_OWNER_PASSWORD was unset\)/);
  });
});

describe("loadRootEnv", () => {
  const KEY = "LOAD_ROOT_ENV_TEST_KEY";

  /** A repo-shaped temp tree: the `.env` sits two levels above the cwd, like packages/db. */
  async function withEnvFile(contents: string, fn: (envPath: string) => void): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "launchos-env-"));
    const cwd = join(root, "packages", "db");
    const originalCwd = process.cwd();
    const originalUrl = process.env.DATABASE_URL;
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, ".env"), contents, "utf8");
    try {
      process.chdir(cwd);
      fn(join(root, ".env"));
    } finally {
      process.chdir(originalCwd);
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      delete process.env[KEY];
      await rm(root, { recursive: true, force: true });
    }
  }

  it("merges keys that are unset even when DATABASE_URL was already set", async () => {
    // The failure this closes: a one-off run with DATABASE_URL on the command
    // line used to skip the file entirely, so the SEED_OWNER_PASSWORD the
    // operator had put in `.env` was never read and the published default was
    // installed in its place.
    await withEnvFile(`DATABASE_URL=postgres://from-file:5432/file\n${KEY}=from-file\n`, (envPath) => {
      process.env.DATABASE_URL = "postgres://localhost:5432/from-shell";

      expect(loadRootEnv()).toBe(envPath);

      expect(process.env[KEY]).toBe("from-file");
      // Never overridden: an explicit variable still wins over the file.
      expect(process.env.DATABASE_URL).toBe("postgres://localhost:5432/from-shell");
    });
  });

  it("still supplies DATABASE_URL when it was not set", async () => {
    await withEnvFile(`DATABASE_URL=postgres://localhost:5432/from-file\n${KEY}=from-file\n`, () => {
      delete process.env.DATABASE_URL;

      loadRootEnv();

      expect(process.env.DATABASE_URL).toBe("postgres://localhost:5432/from-file");
    });
  });

  it("returns null when there is no .env to read", async () => {
    const root = await mkdtemp(join(tmpdir(), "launchos-noenv-"));
    const cwd = join(root, "packages", "db");
    const originalCwd = process.cwd();
    await mkdir(cwd, { recursive: true });
    try {
      process.chdir(cwd);
      expect(loadRootEnv()).toBeNull();
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
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
