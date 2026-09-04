import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  ensureOwnerCredential,
  ensureOwnerMembership,
  ensureUserRow,
  loadRootEnv,
  organisationFromEnv,
  ownerPasswordSource,
  ROOT_ENV_FILE,
} from "./bootstrap.js";
import { DEFAULT_CLIENT_PASSWORD, DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_PASSWORD, MIN_PASSWORD_LENGTH } from "./passwords.js";
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
function guardInput(overrides: { organisationSlug?: string; ownerEmail?: string; ownerPassword?: string } = {}) {
  return {
    organisationSlug: overrides.organisationSlug ?? "acme",
    ownerEmail: overrides.ownerEmail ?? "jo@acme.test",
    ownerPassword: overrides.ownerPassword ?? "a-real-long-password",
  };
}

const LOCAL_URL = "postgres://launchos:launchos@localhost:5432/launchos";
const REMOTE_URL = "postgres://launchos:s3cret@db.launchflow.co.uk:5432/launchos";
/** What `ssh -L 5433:<coolify-postgres>:5432 hetzner` presents production as. */
const TUNNEL_URL = "postgres://launchos:s3cret@localhost:5433/launchos";

/**
 * A developer's local run, configured the way the bootstrap now requires:
 * a real password and the slug confirmed. Nothing here is a "safe" environment
 * as far as the guards are concerned — they run identically on every row below.
 */
const LOCAL = { NODE_ENV: "development", DATABASE_URL: LOCAL_URL, BOOTSTRAP_CONFIRM: "acme" };
const PRODUCTION = { NODE_ENV: "production", DATABASE_URL: LOCAL_URL, BOOTSTRAP_CONFIRM: "acme" };
/** Nobody exported NODE_ENV and the host is remote. */
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

    it("refuses a trailing or doubled hyphen — shapes the app's own slugs never take", () => {
      // `acme-` passed the old pattern and creates a tenant distinct from
      // `acme`: the blank-slug mistake, one character quieter.
      expect(() => assertBootstrapAllowed(guardInput({ organisationSlug: "acme-" }), LOCAL)).toThrow(
        /not a valid slug/,
      );
      expect(() => assertBootstrapAllowed(guardInput({ organisationSlug: "a--b" }), LOCAL)).toThrow(
        /not a valid slug/,
      );
      expect(() =>
        assertBootstrapAllowed(guardInput({ organisationSlug: "grays-cab-line-2" }), {
          ...LOCAL,
          BOOTSTRAP_CONFIRM: "grays-cab-line-2",
        }),
      ).not.toThrow();
    });
  });

  describe("the owner email, in every environment", () => {
    // There is no default. The bootstrap creates the one account that can sign
    // in, and it used to fall back to DEFAULT_OWNER_EMAIL — a real address
    // committed to this repository — so a deployment that forgot the variable
    // made its owner under somebody else's address and was told it succeeded.
    it("refuses an unset SEED_OWNER_EMAIL, which bootstrapInputFromEnv reports as empty", () => {
      for (const env of [LOCAL, PRODUCTION, REMOTE_NO_NODE_ENV]) {
        try {
          assertBootstrapAllowed(guardInput({ ownerEmail: "" }), env);
          expect.unreachable("the owner-email guard should have thrown");
        } catch (error) {
          expect((error as BootstrapGuardError).guard).toBe("owner-email");
          expect((error as Error).message).toMatch(/is not set \(or is empty\)/);
        }
      }
    });

    it("refuses a value that is not an address", () => {
      for (const value of ["Shoji", "jo@localhost", "jo at acme.test", "jo@acme .test", "@acme.test", "jo@"]) {
        expect(() => assertBootstrapAllowed(guardInput({ ownerEmail: value }), LOCAL)).toThrow(
          /not a plausible email address/,
        );
      }
    });

    it("refuses an address longer than SMTP accepts", () => {
      const long = `${"a".repeat(250)}@acme.test`;
      expect(() => assertBootstrapAllowed(guardInput({ ownerEmail: long }), LOCAL)).toThrow(
        /not a plausible email address/,
      );
    });

    it("accepts ordinary addresses, subdomains and plus tags", () => {
      for (const value of ["jo@acme.test", "jo.smith+owner@mail.acme.co.uk", "JO@ACME.TEST", "j_o-1@a-b.io"]) {
        expect(() => assertBootstrapAllowed(guardInput({ ownerEmail: value }), LOCAL)).not.toThrow();
      }
    });

    it("runs before the confirmation, so a missing email is not masked by a missing BOOTSTRAP_CONFIRM", () => {
      try {
        assertBootstrapAllowed(guardInput({ ownerEmail: "" }), { NODE_ENV: "production", DATABASE_URL: REMOTE_URL });
        expect.unreachable("the owner-email guard should have thrown");
      } catch (error) {
        expect((error as BootstrapGuardError).guard).toBe("owner-email");
      }
    });
  });

  describe("the published default, in every environment", () => {
    // The bootstrap is the production tool, and no host string can tell a
    // local database from a live one: a tunnel presents production as
    // `localhost:5433`, a Hetzner private network as `10.x`, and this repo's
    // own production compose file names its database host `postgres`.
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

    it("refuses the owner default against localhost, with NODE_ENV=development", () => {
      try {
        assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), LOCAL);
        expect.unreachable("the published default must be refused on every host");
      } catch (error) {
        expect((error as BootstrapGuardError).guard).toBe("published-default");
      }
    });

    it("refuses the owner default against localhost with NODE_ENV unset", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), {
          DATABASE_URL: LOCAL_URL,
          BOOTSTRAP_CONFIRM: "acme",
        }),
      ).toThrow(/published in this repository/);
    });

    it("refuses the owner default down a tunnel, a private network and the compose service names", () => {
      // Each of these reads as "local" to `isProductionTarget`, and each is a
      // normal way to reach a production database.
      for (const url of [
        TUNNEL_URL,
        "postgres://u:p@10.0.0.3:5432/launchos",
        "postgres://u:p@postgres:5432/launchos",
        "postgres://u:p@db:5432/launchos",
      ]) {
        expect(() =>
          assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), {
            DATABASE_URL: url,
            BOOTSTRAP_CONFIRM: "acme",
          }),
        ).toThrow(/published in this repository/);
      }
    });

    it("refuses the owner default with no DATABASE_URL at all", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput({ ownerPassword: DEFAULT_OWNER_PASSWORD }), { BOOTSTRAP_CONFIRM: "acme" }),
      ).toThrow(/published in this repository/);
    });

    it("allows a real password on any host", () => {
      expect(() => assertBootstrapAllowed(guardInput(), LOCAL)).not.toThrow();
      expect(() => assertBootstrapAllowed(guardInput(), REMOTE_NO_NODE_ENV)).not.toThrow();
    });
  });

  describe("BOOTSTRAP_CONFIRM, in every environment", () => {
    it("refuses on localhost when it is unset", () => {
      // The developer's own machine is not an exception: the confirmation is
      // what says the slug about to be written was meant.
      try {
        assertBootstrapAllowed(guardInput(), { NODE_ENV: "development", DATABASE_URL: LOCAL_URL });
        expect.unreachable("the confirm guard should have thrown");
      } catch (error) {
        expect((error as BootstrapGuardError).guard).toBe("confirm-slug");
        expect((error as Error).message).toMatch(/unset or empty/);
      }
    });

    it("refuses when it is unset and there is no DATABASE_URL", () => {
      expect(() => assertBootstrapAllowed(guardInput(), {})).toThrow(/BOOTSTRAP_CONFIRM/);
    });

    it("refuses when it is empty", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput(), { ...PRODUCTION, BOOTSTRAP_CONFIRM: "   " }),
      ).toThrow(/unset or empty/);
    });

    it("refuses when it does not match the slug", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput({ organisationSlug: "acme" }), {
          ...PRODUCTION,
          BOOTSTRAP_CONFIRM: "acme-typo",
        }),
      ).toThrow(/"acme"/);
    });

    it("allows when it matches the slug", () => {
      expect(() => assertBootstrapAllowed(guardInput(), PRODUCTION)).not.toThrow();
      expect(() => assertBootstrapAllowed(guardInput(), LOCAL)).not.toThrow();
    });

    it("accepts a confirmation with stray whitespace around the right slug", () => {
      expect(() =>
        assertBootstrapAllowed(guardInput(), { ...PRODUCTION, BOOTSTRAP_CONFIRM: " acme " }),
      ).not.toThrow();
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
  const DECOY = "LOAD_ROOT_ENV_DECOY_KEY";

  /** Runs fn, then removes every variable it added and restores DATABASE_URL. */
  async function withCleanEnv(fn: () => void | Promise<void>): Promise<void> {
    const before = new Set(Object.keys(process.env));
    const originalUrl = process.env.DATABASE_URL;
    try {
      await fn();
    } finally {
      for (const key of Object.keys(process.env)) if (!before.has(key)) delete process.env[key];
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    }
  }

  /** A `.env` in a temp directory, passed to `loadRootEnv` explicitly. */
  async function withEnvFile(contents: string, fn: (envPath: string) => void): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "launchos-env-"));
    const envPath = join(root, ".env");
    await writeFile(envPath, contents, "utf8");
    try {
      await withCleanEnv(() => fn(envPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("resolves the repo root from this module's location, not from the cwd", () => {
    // `packages/db/src/env-target.ts` → three directories up. The test file
    // sits beside it, so the same arithmetic must land on the same file — and
    // that depth is the invariant the constant's doc comment names.
    expect(ROOT_ENV_FILE).toBe(join(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), ".env"));
    // And that directory really is the repository root, cwd notwithstanding.
    expect(existsSync(join(dirname(ROOT_ENV_FILE), "pnpm-workspace.yaml"))).toBe(true);
  });

  it("reads only the repo-root file, whatever the cwd is", async () => {
    // The failure this closes: the old ladder resolved `../../.env` against
    // the cwd, so a run from the repository root read a file *two directories
    // above the repository* and reported it as the repo root.
    const outside = await mkdtemp(join(tmpdir(), "launchos-decoy-"));
    const cwd = join(outside, "packages", "db");
    const originalCwd = process.cwd();
    await mkdir(cwd, { recursive: true });
    for (const dir of [outside, join(outside, "packages"), cwd]) {
      await writeFile(join(dir, ".env"), `${DECOY}=from-decoy\n`, "utf8");
    }
    // What the repo-root file actually holds, read here so the assertions below
    // are about which file won rather than about `loadRootEnv`'s return type.
    const rootEnv = existsSync(ROOT_ENV_FILE) ? await readFile(ROOT_ENV_FILE, "utf8") : null;
    try {
      await withCleanEnv(() => {
        // `process.chdir` throws under Vitest's `threads` pool. This suite runs
        // on the default `forks` pool, where it is fine; moving the pool means
        // re-siting this case rather than deleting it.
        process.chdir(cwd);
        // Only the repo-root file can supply this: every decoy defines the
        // decoy key alone, so a ladder that read one would leave it unset.
        delete process.env.DATABASE_URL;

        const read = loadRootEnv();

        expect(read).toBe(rootEnv === null ? null : ROOT_ENV_FILE);
        if (rootEnv !== null && /^\s*DATABASE_URL=/m.test(rootEnv)) {
          expect(process.env.DATABASE_URL).toBeDefined();
        }
        expect(process.env[DECOY]).toBeUndefined();
      });
    } finally {
      process.chdir(originalCwd);
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("merges keys that are unset even when DATABASE_URL was already set", async () => {
    // The failure this closes: a one-off run with DATABASE_URL on the command
    // line used to skip the file entirely, so the SEED_OWNER_PASSWORD the
    // operator had put in `.env` was never read and the published default was
    // installed in its place.
    await withEnvFile(`DATABASE_URL=postgres://from-file:5432/file\n${KEY}=from-file\n`, (envPath) => {
      process.env.DATABASE_URL = "postgres://localhost:5432/from-shell";

      expect(loadRootEnv(envPath)).toBe(envPath);

      expect(process.env[KEY]).toBe("from-file");
      // Never overridden: an explicit variable still wins over the file.
      expect(process.env.DATABASE_URL).toBe("postgres://localhost:5432/from-shell");
    });
  });

  it("still supplies DATABASE_URL when it was not set", async () => {
    await withEnvFile(`DATABASE_URL=postgres://localhost:5432/from-file\n${KEY}=from-file\n`, (envPath) => {
      delete process.env.DATABASE_URL;

      loadRootEnv(envPath);

      expect(process.env.DATABASE_URL).toBe("postgres://localhost:5432/from-file");
    });
  });

  it("returns null when there is no .env to read", async () => {
    const root = await mkdtemp(join(tmpdir(), "launchos-noenv-"));
    try {
      expect(loadRootEnv(join(root, ".env"))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bootstrapInputFromEnv", () => {
  it("has no default owner email — unset and empty both arrive as \"\" for the guard to refuse", () => {
    expect(bootstrapInputFromEnv({} as NodeJS.ProcessEnv).ownerEmail).toBe("");
    expect(bootstrapInputFromEnv({ SEED_OWNER_EMAIL: "" } as NodeJS.ProcessEnv).ownerEmail).toBe("");
    expect(bootstrapInputFromEnv({ SEED_OWNER_EMAIL: "   " } as NodeJS.ProcessEnv).ownerEmail).toBe("");
    // The address committed to this repository must not be reachable from here.
    expect(bootstrapInputFromEnv({} as NodeJS.ProcessEnv).ownerEmail).not.toBe(DEFAULT_OWNER_EMAIL);
  });

  it("trims the owner email, so a pasted value is not a second user row", () => {
    expect(bootstrapInputFromEnv({ SEED_OWNER_EMAIL: " jo@acme.test " } as NodeJS.ProcessEnv).ownerEmail).toBe(
      "jo@acme.test",
    );
  });

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

    it("refuses when the membership exists with a non-owner role, and rolls back", async () => {
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

        // `bootstrap()` is one transaction of its own, so this proves the
        // rollback rather than the ordering — the ordering is pinned by the
        // next case, which calls the two helpers itself.
        const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, user.row.id));
        expect(accounts).toHaveLength(0);
      });
    });

    it("settles the membership before any credential is written", async () => {
      await withTestDb(async (db) => {
        const input = inputFor(randomUUID());
        const organisation = await ensureOrganisation(db, {
          name: input.organisationName,
          slug: input.organisationSlug,
        });
        const user = await ensureUserRow(db, { email: input.ownerEmail, name: input.ownerName });
        await db
          .insert(schema.organisationMembers)
          .values({ organisationId: organisation.row.id, userId: user.row.id, role: "staff", status: "invited" });

        // The two helpers in the order `bootstrap()` calls them, and the order
        // `seed.ts` calls them outside any transaction of its own. If the
        // credential ever moves above the membership check, the refusal below
        // leaves a password hashed onto somebody else's account. `withTestDb`
        // wraps this case in a transaction it rolls back, but that is not what
        // the assertion rests on: a write is visible to a later read inside the
        // same transaction, so an empty `account` means none was made.
        await expect(ensureOwnerMembership(db, organisation.row.id, user.row.id)).rejects.toThrow(
          /role "staff" and status "invited"/,
        );
        const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, user.row.id));
        expect(accounts).toHaveLength(0);

        // And the credential step itself is what would have written one.
        await ensureOwnerCredential(db, user.row.id, input.ownerPassword);
        const after = await db.select().from(schema.account).where(eq(schema.account.userId, user.row.id));
        expect(after).toHaveLength(1);
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
