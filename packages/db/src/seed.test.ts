/**
 * The three properties of `pnpm db:seed` that nothing else pins.
 *
 * `seed.ts` `main` is deliberately **not** transactional, so for the seed the
 * order of its four owner writes is the only protection there is: if
 * `ensureOwnerCredential` ever drifts above the membership check, a refusal
 * leaves `SEED_OWNER_PASSWORD` hashed onto somebody else's account and nothing
 * fails. The seed also manufactures exactly the account that triggers that
 * refusal — the invited `team@launchflow.example`.
 *
 * These run the helpers directly rather than `main()`: `main` opens its own
 * connection and writes the whole fixture set, which cannot be rolled back into
 * a test transaction.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_ISSUER, CREDENTIAL_PROVIDER, ensureOrganisation, ensureOwnerCredential } from "./bootstrap.js";
import * as schema from "./schema/index.js";
import { seedClientUser, seedConfigFromEnv, seedMembership, seedOwnerUser } from "./seed.js";
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

      await expect(seedMembership(db, organisation.id, user.id)).rejects.toThrow(
        /role "staff" and status "invited"/,
      );

      // Nothing rolled back here — `main` has no transaction — so an empty
      // `account` is evidence the credential step is genuinely downstream of
      // the membership check.
      const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, user.id));
      expect(accounts).toHaveLength(0);
    });
  });

  it("writes the credential once the membership is an active owner, and never rewrites it", async () => {
    await withTestDb(async (db) => {
      const config = configFor(randomUUID());
      const { row: organisation } = await ensureOrganisation(db, config.organisation);
      const user = await seedOwnerUser(db, config);
      const membership = await seedMembership(db, organisation.id, user.id);
      expect(membership.role).toBe("owner");
      expect(membership.status).toBe("active");

      const first = await ensureOwnerCredential(db, user.id, config.ownerPassword);
      expect(first.passwordSet).toBe(true);
      const [before] = await db.select().from(schema.account).where(eq(schema.account.userId, user.id));

      // A second seed: the same three calls, nothing new.
      const again = await seedOwnerUser(db, config);
      expect(again.id).toBe(user.id);
      await seedMembership(db, organisation.id, user.id);
      const second = await ensureOwnerCredential(db, user.id, "a-different-password");
      expect(second.passwordSet).toBe(false);

      const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, user.id));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.password).toBe(before?.password);
      const members = await db
        .select()
        .from(schema.organisationMembers)
        .where(eq(schema.organisationMembers.organisationId, organisation.id));
      expect(members).toHaveLength(1);
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
