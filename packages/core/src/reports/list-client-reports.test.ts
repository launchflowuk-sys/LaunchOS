import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { buildClientReport } from "./build-client-report.js";
import { getClientReport, listClientReports } from "./list-client-reports.js";

async function twoClientOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `rep-${randomUUID()}` }).returning();
  const [clientA] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "A", slug: `a-${randomUUID()}` }).returning();
  const [clientB] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "B", slug: `b-${randomUUID()}` }).returning();
  return { orgId: org!.id, clientA: clientA!.id, clientB: clientB!.id };
}

describe("listClientReports", () => {
  it("scopes to the organisation and, when given, a single client", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientA, clientB } = await twoClientOrg(db);
      await buildClientReport(db, orgId, clientA, {
        start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z"),
      });
      await buildClientReport(db, orgId, clientB, {
        start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z"),
      });

      const all = await listClientReports(db, orgId, {});
      expect(all).toHaveLength(2);

      const onlyA = await listClientReports(db, orgId, { clientId: clientA });
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0]!.clientId).toBe(clientA);
    });
  });
});

describe("getClientReport", () => {
  it("returns the report when it belongs to the organisation and client", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientA } = await twoClientOrg(db);
      const report = await buildClientReport(db, orgId, clientA, {
        start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z"),
      });

      const found = await getClientReport(db, orgId, clientA, report.id);
      expect(found?.id).toBe(report.id);
    });
  });

  it("returns null when the report belongs to a different client", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientA, clientB } = await twoClientOrg(db);
      const report = await buildClientReport(db, orgId, clientA, {
        start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z"),
      });

      const found = await getClientReport(db, orgId, clientB, report.id);
      expect(found).toBeNull();
    });
  });
});
