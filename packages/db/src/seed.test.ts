/**
 * The properties of `pnpm db:seed` that nothing else pins.
 *
 * The seed runs **only** on an explicit `SEED_DEMO=1`, and `runSeed` — the
 * sequence `main` actually executes — is deliberately not transactional, so the
 * order of its owner writes is the only protection there is: if the credential
 * ever drifts above the membership check, a refusal leaves
 * `SEED_OWNER_PASSWORD` hashed onto somebody else's account and nothing fails.
 * The seed manufactures exactly the account that triggers that refusal — the
 * invited `team@launchflow.example`.
 *
 * The ordering case calls `runSeed` itself rather than re-assembling its steps
 * here, so it is evidence about production code. The rest call the exported
 * helpers directly: `main` reads the environment, opens its own connection and
 * writes the whole fixture set.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BootstrapGuardError, CREDENTIAL_ISSUER, CREDENTIAL_PROVIDER, ensureOrganisation } from "./bootstrap.js";
import { DEFAULT_OWNER_EMAIL } from "./passwords.js";
import * as schema from "./schema/index.js";
import {
  assertDemoOptIn,
  assertSeedOwnerEmail,
  runSeed,
  seedClientUser,
  seedConfigFromEnv,
  seedOwnerAccount,
  seedOwnerUser,
} from "./seed.js";
import { withTestDb } from "./test/db.js";

/** A unique organisation, owner and portal user per test. */
function configFor(stamp: string) {
  return seedConfigFromEnv({
    SEED_ORG_NAME: `Test Agency ${stamp}`,
    SEED_ORG_SLUG: `test-${stamp}`,
    SEED_OWNER_EMAIL: `owner.${stamp}@launchos.test`,
    SEED_OWNER_PASSWORD: `real-owner-${stamp}`,
    SEED_CLIENT_EMAIL: `portal.${stamp}@launchos.test`,
    SEED_CLIENT_PASSWORD: `real-client-${stamp}`,
  } as NodeJS.ProcessEnv);
}

async function seedClientRow(db: Parameters<Parameters<typeof withTestDb>[0]>[0], organisationId: string, stamp: string) {
  const [client] = await db
    .insert(schema.clients)
    .values({ organisationId, name: `Client ${stamp}`, slug: `client-${stamp}` })
    .returning();
  return client!;
}

describe("seedConfigFromEnv", () => {
  it("reads nothing at module scope — importing the seed must not touch process.env", () => {
    // The variables are read here, from the env passed in, not when the module
    // is collected. `loadRootEnv()` moved into `main` for the same reason.
    const config = seedConfigFromEnv({ SEED_OWNER_EMAIL: "jo@acme.test", SEED_ORG_SLUG: "acme" } as NodeJS.ProcessEnv);
    expect(config.ownerEmail).toBe("jo@acme.test");
    expect(config.organisation.slug).toBe("acme");
  });

  it("gives the portal login its own password, never the owner's", () => {
    const config = seedConfigFromEnv({ SEED_OWNER_PASSWORD: "owner-password-here" } as NodeJS.ProcessEnv);
    expect(config.clientUser.password).not.toBe(config.ownerPassword);
  });

  it("keeps the development default owner email, and treats an empty value as unset", () => {
    // `.env.example` ships SEED_OWNER_EMAIL blank, because the bootstrap has no
    // default and must refuse an unset one. A blank key must therefore not
    // break `pnpm db:seed`, the local path — unlike SEED_ORG_SLUG, where an
    // empty value is the mistake worth catching.
    expect(seedConfigFromEnv({} as NodeJS.ProcessEnv).ownerEmail).toBe(DEFAULT_OWNER_EMAIL);
    expect(seedConfigFromEnv({ SEED_OWNER_EMAIL: "" } as NodeJS.ProcessEnv).ownerEmail).toBe(DEFAULT_OWNER_EMAIL);
    expect(seedConfigFromEnv({ SEED_OWNER_EMAIL: " jo@acme.test " } as NodeJS.ProcessEnv).ownerEmail).toBe(
      "jo@acme.test",
    );
  });
});

describe("assertDemoOptIn", () => {
  it("refuses when SEED_DEMO is unset, whatever the target looks like", () => {
    // A local-looking host is not consent: `ssh -L 5433:…` presents a live
    // database as localhost, which is why this guard reads a variable and not a
    // hostname. Neither environment below can satisfy it.
    for (const env of [
      {},
      { NODE_ENV: "development", DATABASE_URL: "postgres://u:p@localhost:5432/launchos" },
      { NODE_ENV: "development", DATABASE_URL: "postgres://u:p@localhost:5433/launchos" },
      { NODE_ENV: "development", DATABASE_URL: "postgres://u:p@10.0.0.3:5432/launchos" },
      { NODE_ENV: "development", DATABASE_URL: "postgres://u:p@postgres:5432/launchos" },
      { NODE_ENV: "development", DATABASE_URL: "postgres://u:p@db:5432/launchos" },
    ]) {
      try {
        assertDemoOptIn(env as NodeJS.ProcessEnv);
        expect.unreachable(`the demo-opt-in guard should have thrown for ${JSON.stringify(env)}`);
      } catch (error) {
        expect((error as BootstrapGuardError).guard).toBe("demo-opt-in");
        expect((error as Error).message).toMatch(/SEED_DEMO=1/);
      }
    }
  });

  it("refuses anything but exactly 1 — a value that reads as off is not consent", () => {
    for (const value of ["", "0", "false", "true", "yes", " 1", "1 ", "01"]) {
      expect(() => assertDemoOptIn({ SEED_DEMO: value } as NodeJS.ProcessEnv)).toThrow(/SEED_DEMO=1/);
    }
  });

  it("runs on SEED_DEMO=1, including against a production target", () => {
    // The flag is the whole gate: having said it out loud, the operator gets
    // the fixtures wherever they pointed the run.
    expect(() => assertDemoOptIn({ SEED_DEMO: "1" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() =>
      assertDemoOptIn({
        SEED_DEMO: "1",
        NODE_ENV: "production",
        DATABASE_URL: "postgres://u:p@db.launchflow.co.uk:5432/launchos",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe("assertSeedOwnerEmail", () => {
  const LOCAL = { NODE_ENV: "development", DATABASE_URL: "postgres://u:p@localhost:5432/launchos" };
  /** Nobody exported NODE_ENV and the host is not local — the run these guards exist for. */
  const REMOTE = { DATABASE_URL: "postgres://u:p@db.launchflow.co.uk:5432/launchos" };

  it("lets the local seed run on the built-in default", () => {
    expect(() => assertSeedOwnerEmail(LOCAL as NodeJS.ProcessEnv, DEFAULT_OWNER_EMAIL, false)).not.toThrow();
  });

  it("refuses a value that is not an address, in every environment", () => {
    expect(() =>
      assertSeedOwnerEmail({ ...LOCAL, SEED_OWNER_EMAIL: "Shoji" } as NodeJS.ProcessEnv, "Shoji", false),
    ).toThrow(/not a plausible email address/);
  });

  it("requires SEED_OWNER_EMAIL to be set against a production target", () => {
    // Reachable only with SEED_DEMO=1 already said out loud — and at that point
    // the seed is writing the same privileged owner account the bootstrap
    // would, so it must not write it under an address from this repository.
    try {
      assertSeedOwnerEmail(REMOTE as NodeJS.ProcessEnv, DEFAULT_OWNER_EMAIL, true);
      expect.unreachable("the owner-email guard should have thrown");
    } catch (error) {
      expect((error as BootstrapGuardError).guard).toBe("owner-email");
      expect((error as Error).message).toMatch(/development default committed to this repository/);
      // The half of the predicate that fired, for an operator who never set NODE_ENV.
      expect((error as Error).message).toMatch(/not a local host/);
    }
  });

  it("accepts an explicit address against a production target", () => {
    expect(() =>
      assertSeedOwnerEmail({ ...REMOTE, SEED_OWNER_EMAIL: "jo@acme.test" } as NodeJS.ProcessEnv, "jo@acme.test", true),
    ).not.toThrow();
  });

  it("refuses a whitespace-only SEED_OWNER_EMAIL against a production target", () => {
    // It falls back to the default in `seedConfigFromEnv`, so the plausible
    // address it carries must not be read as "the operator set one".
    expect(() =>
      assertSeedOwnerEmail({ ...REMOTE, SEED_OWNER_EMAIL: "   " } as NodeJS.ProcessEnv, DEFAULT_OWNER_EMAIL, true),
    ).toThrow(/is not set/);
  });
});

describe("the seed's owner sequence", () => {
  it("refuses a non-owner membership before any credential is written", async () => {
    await withTestDb(async (db) => {
      const stamp = randomUUID();
      const config = configFor(stamp);
      const { row: organisation } = await ensureOrganisation(db, config.organisation);
      const user = await seedOwnerUser(db, config);
      // Exactly what the seed's own `seedStaffMember` writes, and what /team
      // writes for an invited staff member: a membership, no credential.
      await db
        .insert(schema.organisationMembers)
        .values({ organisationId: organisation.id, userId: user.id, role: "staff", status: "invited" });

      // `runSeed` is the sequence `main` executes, not a copy of it assembled
      // here: reorder the owner writes in `seed.ts` and this is what fails.
      await expect(runSeed(db, config)).rejects.toThrow(/role "staff" and status "invited"/);

      // `withTestDb` does wrap this case in a transaction, and always rolls it
      // back — but that is not what makes the assertion hold. A write made
      // earlier in a transaction is visible to a later read inside the same
      // one, so an empty `account` here means the credential step never ran,
      // which is the property `runSeed` has to keep outside a transaction too.
      const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, user.id));
      expect(accounts).toHaveLength(0);
    });
  });

  it("writes the credential once the membership is an active owner, and never rewrites it", async () => {
    await withTestDb(async (db) => {
      const config = configFor(randomUUID());
      const first = await seedOwnerAccount(db, config);
      expect(first.membership.role).toBe("owner");
      expect(first.membership.status).toBe("active");
      const [before] = await db.select().from(schema.account).where(eq(schema.account.userId, first.user.id));
      expect(before?.password).toBeTruthy();

      // A second seed, with a different password in the environment: the
      // existing credential is kept and no second organisation appears.
      const second = await seedOwnerAccount(db, { ...config, ownerPassword: "a-different-password" });
      expect(second.user.id).toBe(first.user.id);
      expect(second.organisation.id).toBe(first.organisation.id);

      const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, first.user.id));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.password).toBe(before?.password);
      const members = await db
        .select()
        .from(schema.organisationMembers)
        .where(eq(schema.organisationMembers.organisationId, first.organisation.id));
      expect(members).toHaveLength(1);
      const organisations = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.slug, config.organisation.slug));
      expect(organisations).toHaveLength(1);
    });
  });
});

describe("seedClientUser", () => {
  it("keeps an existing account rather than attaching SEED_CLIENT_PASSWORD to it", async () => {
    await withTestDb(async (db) => {
      const stamp = randomUUID();
      const config = configFor(stamp);
      const { row: organisation } = await ensureOrganisation(db, config.organisation);
      const client = await seedClientRow(db, organisation.id, stamp);
      // A portal user who already exists, linked only to an external provider.
      // Any `account` row means this is somebody's sign-in the seed has no
      // business changing — not just a credential one.
      const [existing] = await db
        .insert(schema.user)
        .values({ id: randomUUID(), name: "Existing", email: config.clientUser.email, emailVerified: true })
        .returning();
      await db.insert(schema.account).values({
        id: randomUUID(),
        accountId: "external-123",
        providerId: "github",
        issuer: "https://github.com",
        userId: existing!.id,
      });

      const user = await seedClientUser(db, organisation.id, client.id, config.clientUser);

      expect(user.id).toBe(existing!.id);
      const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, user.id));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.providerId).toBe("github");
      expect(accounts[0]?.password).toBeNull();
      // The portal link is still created: the account is left alone, the
      // client scoping is not.
      const links = await db
        .select()
        .from(schema.clientUsers)
        .where(and(eq(schema.clientUsers.clientId, client.id), eq(schema.clientUsers.userId, user.id)));
      expect(links).toHaveLength(1);
    });
  });

  it("is idempotent — a second run creates nothing", async () => {
    await withTestDb(async (db) => {
      const stamp = randomUUID();
      const config = configFor(stamp);
      const { row: organisation } = await ensureOrganisation(db, config.organisation);
      const client = await seedClientRow(db, organisation.id, stamp);

      const first = await seedClientUser(db, organisation.id, client.id, config.clientUser);
      const [credential] = await db.select().from(schema.account).where(eq(schema.account.userId, first.id));
      expect(credential?.providerId).toBe(CREDENTIAL_PROVIDER);
      expect(credential?.issuer).toBe(CREDENTIAL_ISSUER);
      expect(credential?.password).not.toBe(config.clientUser.password); // hashed

      const second = await seedClientUser(db, organisation.id, client.id, config.clientUser);

      expect(second.id).toBe(first.id);
      const users = await db.select().from(schema.user).where(eq(schema.user.email, config.clientUser.email));
      expect(users).toHaveLength(1);
      const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, first.id));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.password).toBe(credential?.password);
      const links = await db.select().from(schema.clientUsers).where(eq(schema.clientUsers.userId, first.id));
      expect(links).toHaveLength(1);
    });
  });
});
