import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../schema/index.js";
import { withTestDb } from "../test/db.js";
import {
  applyChanges,
  loadClients,
  parseFlags,
  planReconciliation,
  resolveDomain,
} from "./reconcile-support-emails.js";

const client = (
  orgSlug: string,
  slug: string,
  supportEmail: string | null,
  identityAddress: string | null = supportEmail,
) => ({
  id: `${orgSlug}-${slug}`,
  organisationId: orgSlug,
  orgSlug,
  slug,
  name: slug,
  supportEmail,
  identityId: identityAddress === null ? null : `${orgSlug}-${slug}-identity`,
  identityAddress,
});

describe("planReconciliation", () => {
  it("re-points addresses left on the migration's literal domain", () => {
    const changes = planReconciliation(
      [client("launchflow", "acme", "acme@support.launchflow.co.uk")],
      "support.launchflow.io",
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.to).toBe("acme@support.launchflow.io");
  });

  it("leaves rows that already match in both tables alone", () => {
    expect(planReconciliation([client("launchflow", "acme", "acme@support.example")], "support.example")).toEqual([]);
  });

  it("changes a row whose identity address is stale even when clients.support_email matches", () => {
    // The failure the previous version could not see: the displayed address was
    // right and the routable one — the only one inbound mail matches — was not.
    const changes = planReconciliation(
      [client("launchflow", "acme", "acme@support.example", "acme@support.launchflow.co.uk")],
      "support.example",
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      from: "acme@support.example",
      identityFrom: "acme@support.launchflow.co.uk",
      to: "acme@support.example",
    });
  });

  it("fills in a NULL address", () => {
    const changes = planReconciliation([client("launchflow", "acme", null)], "support.example");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: null, identityFrom: null, to: "acme@support.example" });
  });

  it("skips the unmatched holding client and never claims its local part", () => {
    // The holding client is a bucket for mail that matched nothing. Giving it an
    // address would make `unmatched@<domain>` deliverable into it.
    const changes = planReconciliation(
      [client("launchflow", "unmatched", null), client("launchflow", "acme", null)],
      "support.example",
    );
    expect(changes.map((c) => c.client.slug)).toEqual(["acme"]);
  });

  it("suffixes the later organisation when two orgs share a client slug", () => {
    // `slug` is unique per organisation but both addresses are unique globally,
    // so the same slug in two orgs is the collision migration 0007 could not see.
    const changes = planReconciliation(
      [client("launchflow", "acme", null), client("other-agency", "acme", null)],
      "support.example",
    );
    expect(changes.map((c) => c.to)).toEqual(["acme@support.example", "acme-other-agency@support.example"]);
  });

  it("keeps the first organisation's existing address untouched on a collision", () => {
    const changes = planReconciliation(
      [client("launchflow", "acme", "acme@support.example"), client("other-agency", "acme", null)],
      "support.example",
    );
    expect(changes.map((c) => c.to)).toEqual(["acme-other-agency@support.example"]);
  });

  it("never produces a duplicate address, however many organisations collide", () => {
    const changes = planReconciliation(
      [
        client("a", "acme", null),
        client("b", "acme", null),
        client("c", "acme", null),
        // An address that would collide with the suffix chosen for org b.
        client("c", "acme-b", null),
      ],
      "support.example",
    );
    const targets = changes.map((c) => c.to);
    expect(targets).toHaveLength(4);
    expect(new Set(targets).size).toBe(4);
  });
});

describe("resolveDomain", () => {
  it("uses SUPPORT_EMAIL_DOMAIN when it is set", () => {
    expect(resolveDomain({ SUPPORT_EMAIL_DOMAIN: " Support.Example " } as NodeJS.ProcessEnv, false)).toBe(
      "support.example",
    );
  });

  it("refuses to mass-rewrite onto the built-in fallback domain unless asked out loud", () => {
    // Anyone with DATABASE_URL exported but no SUPPORT_EMAIL_DOMAIN would
    // otherwise rewrite every address to the fallback — the exact damage the
    // script exists to repair — and exit 0.
    expect(() => resolveDomain({} as NodeJS.ProcessEnv, false)).toThrow("SUPPORT_EMAIL_DOMAIN is not set");
    expect(resolveDomain({} as NodeJS.ProcessEnv, true)).toBe("support.launchflow.co.uk");
  });

  it("rejects a malformed domain", () => {
    expect(() => resolveDomain({ SUPPORT_EMAIL_DOMAIN: "not a domain" } as NodeJS.ProcessEnv, false)).toThrow();
  });
});

describe("parseFlags", () => {
  it("rejects an unknown or mistyped flag rather than applying the rewrite", () => {
    expect(() => parseFlags(["--dryrun"])).toThrow('unknown argument "--dryrun"');
    expect(() => parseFlags(["-n"])).toThrow('unknown argument "-n"');
  });

  it("reads the three supported flags", () => {
    expect(parseFlags(["--dry-run"])).toEqual({ dryRun: true, yes: false, allowDefaultDomain: false });
    expect(parseFlags(["--yes", "--allow-default-domain"])).toEqual({
      dryRun: false,
      yes: true,
      allowDefaultDomain: true,
    });
    expect(parseFlags([])).toEqual({ dryRun: false, yes: false, allowDefaultDomain: false });
    // pnpm forwards its own separator through: `pnpm db:… -- --dry-run`.
    expect(parseFlags(["--", "--dry-run"])).toEqual({ dryRun: true, yes: false, allowDefaultDomain: false });
  });
});

const DOMAIN = "support.reconcile.test";

/** The dev database holds seeded clients; only the rows this test made are planned. */
async function planForOrgs(db: Parameters<typeof loadClients>[0], orgIds: readonly string[]) {
  const rows = (await loadClients(db)).filter((r) => orgIds.includes(r.organisationId));
  return planReconciliation(rows, DOMAIN);
}

async function makeOrg(db: Parameters<typeof loadClients>[0], name: string, createdAt: Date) {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name, slug: `${name}-${crypto.randomUUID().slice(0, 8)}`, createdAt })
    .returning();
  return org!;
}

describe("applyChanges", () => {
  it("rewrites clients.support_email and email_identities.address together, and audits each", async () => {
    await withTestDb(async (db) => {
      // `now()` is the transaction timestamp, so every default createdAt in this
      // test would be identical: set them explicitly or the "oldest organisation
      // keeps the plain local part" ordering is a coin toss.
      const orgA = await makeOrg(db, "older", new Date("2026-01-01T00:00:00Z"));
      const orgB = await makeOrg(db, "newer", new Date("2026-02-01T00:00:00Z"));
      const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;

      // Org A: both copies stranded on a domain this deployment does not own.
      const [a] = await db
        .insert(schema.clients)
        .values({
          organisationId: orgA.id,
          name: "Acme A",
          slug,
          supportEmail: `${slug}@old.example`,
          createdAt: new Date("2026-01-02T00:00:00Z"),
        })
        .returning();
      await db.insert(schema.emailIdentities).values({
        organisationId: orgA.id,
        clientId: a!.id,
        address: `${slug}@old.example`,
        inboundSecret: "secret-a",
      });

      // Org B: the same slug, no address and no identity row at all.
      const [b] = await db
        .insert(schema.clients)
        .values({ organisationId: orgB.id, name: "Acme B", slug, createdAt: new Date("2026-02-02T00:00:00Z") })
        .returning();

      // The holding client must come out untouched.
      const [holding] = await db
        .insert(schema.clients)
        .values({ organisationId: orgB.id, name: "Unmatched inbound", slug: "unmatched" })
        .returning();

      const changes = await planForOrgs(db, [orgA.id, orgB.id]);
      expect(changes.map((c) => c.client.id)).toEqual([a!.id, b!.id]);
      await applyChanges(db, changes);

      const expectedA = `${slug}@${DOMAIN}`;
      const expectedB = `${slug}-${orgB.slug}@${DOMAIN}`;

      const after = await db.select().from(schema.clients).where(eq(schema.clients.slug, slug));
      expect(after.find((r) => r.id === a!.id)!.supportEmail).toBe(expectedA);
      expect(after.find((r) => r.id === b!.id)!.supportEmail).toBe(expectedB);

      const identityA = await db.select().from(schema.emailIdentities).where(eq(schema.emailIdentities.clientId, a!.id));
      expect(identityA[0]!.address).toBe(expectedA);
      const identityB = await db.select().from(schema.emailIdentities).where(eq(schema.emailIdentities.clientId, b!.id));
      expect(identityB).toHaveLength(1);
      expect(identityB[0]!.address).toBe(expectedB);
      expect(identityB[0]!.organisationId).toBe(orgB.id);
      expect(identityB[0]!.inboundSecret).toHaveLength(48);

      const [holdingAfter] = await db.select().from(schema.clients).where(eq(schema.clients.id, holding!.id));
      expect(holdingAfter!.supportEmail).toBeNull();
      expect(
        await db.select().from(schema.emailIdentities).where(eq(schema.emailIdentities.clientId, holding!.id)),
      ).toHaveLength(0);

      const auditA = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.organisationId, orgA.id));
      expect(auditA.map((r) => r.action).sort()).toEqual([
        "client.support_email_reconciled",
        "email_identity.address_reconciled",
      ]);

      const auditB = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.organisationId, orgB.id));
      expect(auditB.map((r) => r.action).sort()).toEqual(["client.support_email_reconciled", "email_identity.created"]);

      const [emailAudit] = await db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.organisationId, orgA.id),
            eq(schema.auditLog.action, "client.support_email_reconciled"),
          ),
        );
      expect(emailAudit!.targetId).toBe(a!.id);
      expect(emailAudit!.before).toEqual({ supportEmail: `${slug}@old.example` });
      expect(emailAudit!.after).toEqual({ supportEmail: expectedA });

      // Re-running changes nothing: both copies now agree with the domain.
      expect(await planForOrgs(db, [orgA.id, orgB.id])).toEqual([]);
    });
  });

  it("survives two clients swapping addresses, which a one-by-one rewrite could not", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db, "swap", new Date("2026-01-01T00:00:00Z"));
      const one = `one-${crypto.randomUUID().slice(0, 8)}`;
      const two = `two-${crypto.randomUUID().slice(0, 8)}`;

      // Each client is sitting on the address the other one is about to be
      // given — the case both unique indexes would reject mid-loop.
      for (const [slug, held] of [
        [one, two],
        [two, one],
      ]) {
        const [row] = await db
          .insert(schema.clients)
          .values({ organisationId: org.id, name: slug!, slug: slug!, supportEmail: `${held}@${DOMAIN}` })
          .returning();
        await db.insert(schema.emailIdentities).values({
          organisationId: org.id,
          clientId: row!.id,
          address: `${held}@${DOMAIN}`,
          inboundSecret: `secret-${slug}`,
        });
      }

      const changes = await planForOrgs(db, [org.id]);
      expect(changes).toHaveLength(2);
      await applyChanges(db, changes);

      const rows = await db.select().from(schema.clients).where(eq(schema.clients.organisationId, org.id));
      expect(rows.map((r) => r.supportEmail).sort()).toEqual([`${one}@${DOMAIN}`, `${two}@${DOMAIN}`].sort());

      const identities = await db
        .select()
        .from(schema.emailIdentities)
        .where(eq(schema.emailIdentities.organisationId, org.id));
      expect(identities.map((r) => r.address).sort()).toEqual([`${one}@${DOMAIN}`, `${two}@${DOMAIN}`].sort());
      for (const row of rows) {
        const identity = identities.find((i) => i.clientId === row.id);
        expect(identity!.address).toBe(row.supportEmail);
      }
    });
  });
});
