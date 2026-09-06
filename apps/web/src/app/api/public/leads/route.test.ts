import { randomUUID } from "node:crypto";
import { attributionOf, listLeads } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentDb: Db | undefined;
let currentToken: string | null = null;
let currentOrganisationId: string | null = null;
vi.mock("@/lib/db", () => ({ getDb: () => currentDb! }));
vi.mock("@/lib/env", () => ({ publicFormsToken: () => currentToken }));
vi.mock("@/lib/queue", () => ({ installWebEnqueue: () => undefined }));
// `withTestDb` is a transaction on the shared dev database, where the seeded
// "launchflow" organisation is always the oldest active one; the lookup is
// stubbed so each case lands on the organisation it seeded.
vi.mock("@/lib/public-organisation", () => ({ publicOrganisationId: async () => currentOrganisationId }));

import { LEADS_RATE_LIMIT, limiter, TOKEN_HEADER } from "./intake.js";
import { POST } from "./route.js";

const TOKEN = "forms-token-for-tests-0123456789";

function post(body: unknown, token: string | null = TOKEN, address = "203.0.113.5"): Promise<Response> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text, "utf8")),
    "x-forwarded-for": address,
  };
  if (token !== null) headers[TOKEN_HEADER] = token;
  return POST(new Request("http://localhost/api/public/leads", { method: "POST", headers, body: text }));
}

/** An organisation for the leads to land on, plus an owner so the bell has someone to ring. */
async function seedOrganisation(db: Db): Promise<string> {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `public-leads-${randomUUID()}` }).returning();
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Owner", email: `o-${userId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId, role: "owner", status: "active" });
  currentOrganisationId = org!.id;
  return org!.id;
}

describe("POST /api/public/leads", () => {
  beforeEach(() => {
    currentToken = TOKEN;
    // A fresh window per case: the limiter is module-scope by design.
    limiter["buckets"].clear();
  });

  afterEach(() => {
    currentDb = undefined;
    currentToken = null;
    currentOrganisationId = null;
  });

  it("answers 503 while PUBLIC_FORMS_TOKEN is unset, before reading anything", async () => {
    currentToken = null;
    const res = await post({ name: "Somebody" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("PUBLIC_FORMS_TOKEN");
  });

  it("answers 503 when no organisation is active", async () => {
    currentOrganisationId = null;
    expect((await post({ name: "Somebody" })).status).toBe(503);
  });

  it("refuses a missing or wrong token with 401", async () => {
    expect((await post({ name: "Somebody" }, null)).status).toBe(401);
    expect((await post({ name: "Somebody" }, "wrong")).status).toBe(401);
    expect((await post({ name: "Somebody" }, `${TOKEN}x`)).status).toBe(401);
  });

  it("records a lead on the active organisation with source website and rings the owner", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const organisationId = await seedOrganisation(db);
      const res = await post({
        name: "  Jane Driver ",
        email: "JANE@example.test",
        phone: "07700 900000",
        business: "Jane's Cabs",
        message: "Need a new website for the taxi firm.",
        page: "/contact",
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; id: string };
      expect(json.ok).toBe(true);

      const { leads } = await listLeads(db, organisationId, {});
      expect(leads).toHaveLength(1);
      const lead = leads[0]!;
      expect(lead.id).toBe(json.id);
      expect(lead.name).toBe("Jane Driver");
      expect(lead.email).toBe("jane@example.test");
      expect(lead.business).toBe("Jane's Cabs");
      expect(lead.source).toBe("website");
      expect(lead.status).toBe("new");
      expect((lead.metadata as { page?: string }).page).toBe("/contact");

      const bells = await db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, organisationId));
      expect(bells.map((b) => b.kind)).toContain("lead.created");
      expect(bells[0]?.link).toBe(`/leads/${lead.id}`);
    });
  });

  it("stores the attribution the form carried, and refuses one that is not short strings", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const organisationId = await seedOrganisation(db);
      const res = await post({
        name: "Sam Salon",
        email: "sam@example.test",
        attribution: { utmSource: "google", utmMedium: "cpc", utmCampaign: "spring-launch", landingPath: "/pricing", referrer: "www.google.com" },
      });
      expect(res.status).toBe(200);
      const { leads } = await listLeads(db, organisationId, { utmCampaign: "spring-launch" });
      expect(leads).toHaveLength(1);
      expect(attributionOf(leads[0]!.metadata)).toEqual({
        utmSource: "google", utmMedium: "cpc", utmCampaign: "spring-launch", landingPath: "/pricing", referrer: "www.google.com",
      });

      expect((await post({ name: "Bad", attribution: { utmSource: "x".repeat(201) } })).status).toBe(400);
      expect((await post({ name: "Bad", attribution: "google" })).status).toBe(400);
      expect((await listLeads(db, organisationId, {})).total).toBe(1);
    });
  });

  it("refuses a bad body with 400 and never writes", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const organisationId = await seedOrganisation(db);
      expect((await post({ email: "nobody@example.test" })).status).toBe(400);
      expect((await post({ name: "X", email: "not-an-address" })).status).toBe(400);
      expect((await post("not json")).status).toBe(400);
      expect((await listLeads(db, organisationId, {})).total).toBe(0);
    });
  });

  it("rate-limits one address after the hourly budget, and answers retry-after", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const organisationId = await seedOrganisation(db);
      for (let i = 0; i < LEADS_RATE_LIMIT.limit; i += 1) {
        expect((await post({ name: `Lead ${i}` }, TOKEN, "198.51.100.9")).status).toBe(200);
      }
      const refused = await post({ name: "One too many" }, TOKEN, "198.51.100.9");
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      // Another address is unaffected.
      expect((await post({ name: "Neighbour" }, TOKEN, "198.51.100.10")).status).toBe(200);
      expect((await listLeads(db, organisationId, {})).total).toBe(LEADS_RATE_LIMIT.limit + 1);
    });
  });
});
