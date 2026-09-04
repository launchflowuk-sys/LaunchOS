import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

/**
 * The three status columns `getClientSession` gates on are the whole of
 * "portal access can be taken away", and they are duplicated across this file
 * and `session.ts` with nothing pinning them down. `ne(clients.status,
 * "archived")` in particular is the kind of negative condition that gets
 * "tidied" into `eq(clients.status, "active")`, which would silently cut off
 * every paused client. So this runs the real query against the real docker
 * Postgres — only the request-scoped edges are faked.
 */

let currentDb: Db | undefined;
let currentUser: { id: string; email: string; name: string } | null = null;

vi.mock("./db", () => ({ getDb: () => currentDb! }));
vi.mock("./session", () => ({
  getAuthUser: async () => currentUser,
  // Nobody in these tests is staff; the staff branch has its own e2e test.
  getSession: async () => null,
}));
// `cache()` is a request-scoped memo. Outside a render there is no request, and
// a memo that outlived one test would answer the next one from the wrong row.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T,>(fn: T) => fn };
});

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const { ACCESS_REVOKED, getClientSession, hasRevokedPortalAccess, requireClient } = await import("./portal-session");

async function seedPortalUser(db: Db) {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "T", slug: `t-${randomUUID()}` })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` })
    .returning();
  const userId = randomUUID();
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Jo", email: `jo-${userId}@client.test`, emailVerified: true });
  const [row] = await db
    .insert(schema.clientUsers)
    .values({ organisationId: org!.id, clientId: client!.id, userId, role: "client_admin" })
    .returning();

  currentDb = db;
  currentUser = { id: userId, email: `jo-${userId}@client.test`, name: "Jo" };
  return { organisation: org!, client: client!, userId, clientUser: row! };
}

describe("getClientSession", () => {
  it("resolves an active portal user on an active client", async () => {
    await withTestDb(async (db) => {
      const { organisation, client, userId } = await seedPortalUser(db);

      const session = await getClientSession();

      expect(session).toMatchObject({
        userId,
        organisationId: organisation.id,
        clientId: client.id,
        clientName: "C",
        role: "client_admin",
      });
    });
  });

  it("refuses a suspended portal user", async () => {
    await withTestDb(async (db) => {
      const { clientUser } = await seedPortalUser(db);

      await db
        .update(schema.clientUsers)
        .set({ status: "suspended" })
        .where(eq(schema.clientUsers.id, clientUser.id));

      expect(await getClientSession()).toBeNull();
      // The row still exists, which is what tells the gate to say "removed"
      // rather than "wrong password".
      expect(await hasRevokedPortalAccess(clientUser.userId)).toBe(true);
    });
  });

  it("keeps a paused client's portal but takes an archived client's away", async () => {
    await withTestDb(async (db) => {
      const { client } = await seedPortalUser(db);

      await db.update(schema.clients).set({ status: "paused" }).where(eq(schema.clients.id, client.id));
      // `paused` is a commercial state, not a security one.
      expect(await getClientSession()).not.toBeNull();

      await db.update(schema.clients).set({ status: "archived" }).where(eq(schema.clients.id, client.id));
      expect(await getClientSession()).toBeNull();
    });
  });

  it("refuses a user whose organisation has been switched off", async () => {
    await withTestDb(async (db) => {
      const { organisation } = await seedPortalUser(db);

      await db
        .update(schema.organisations)
        .set({ status: "suspended" })
        .where(eq(schema.organisations.id, organisation.id));

      expect(await getClientSession()).toBeNull();
    });
  });

  it("refuses a signed-in user with no portal row at all", async () => {
    await withTestDb(async (db) => {
      const { clientUser } = await seedPortalUser(db);
      await db.delete(schema.clientUsers).where(eq(schema.clientUsers.id, clientUser.id));

      expect(await getClientSession()).toBeNull();
      // Nothing was revoked — this user simply never had a portal.
      expect(await hasRevokedPortalAccess(clientUser.userId)).toBe(false);
    });
  });
});

describe("requireClient", () => {
  it("sends a suspended user to the sign-in page with the revoked reason", async () => {
    await withTestDb(async (db) => {
      const { clientUser } = await seedPortalUser(db);
      await db
        .update(schema.clientUsers)
        .set({ status: "suspended" })
        .where(eq(schema.clientUsers.id, clientUser.id));

      await expect(requireClient()).rejects.toThrow(new RegExp(`/sign-in\\?reason=${ACCESS_REVOKED}`));
    });
  });

  it("sends somebody who never had a portal to a plain sign-in", async () => {
    await withTestDb(async (db) => {
      const { clientUser } = await seedPortalUser(db);
      await db.delete(schema.clientUsers).where(eq(schema.clientUsers.id, clientUser.id));

      await expect(requireClient()).rejects.toThrow(/redirect \/sign-in$/);
    });
  });
});
