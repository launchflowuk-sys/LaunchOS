import { describe, expect, it } from "vitest";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { createFunnel, getFunnel, listFunnels, publishedFunnelBySlug, setFunnelStatus, updateFunnel } from "./crud.js";
import { answerFunnelStep, completeFunnelSession, sessionByToken } from "./sessions.js";
import { defaultFunnelSteps, FunnelStepsSchema, maximumScore } from "./steps.js";
import { funnelPerformance, recentFunnelSessions } from "./summary.js";

const env = { MAIL_FROM: "hello@example.test", APP_URL: "http://localhost:3000" } as NodeJS.ProcessEnv;

async function publishedFunnel(db: Parameters<typeof createFunnel>[0], organisationId: string, slug: string, hotScore = 50) {
  const funnel = await createFunnel(db, organisationId, { name: "Website enquiry", slug, hotScore, actorId: "u1" });
  return setFunnelStatus(db, organisationId, { funnelId: funnel.id, status: "published", actorId: "u1" });
}

describe("funnel configuration", () => {
  it("refuses a shape that is not a funnel: no contact step, or one at the end", () => {
    const steps = defaultFunnelSteps();
    expect(FunnelStepsSchema.safeParse(steps).success).toBe(true);

    const noContact = steps.filter((step) => step.kind !== "contact");
    expect(FunnelStepsSchema.safeParse(noContact).error?.issues[0]?.message).toMatch(/needs a contact step/);

    const contactLast = [...steps.filter((step) => step.kind !== "contact"), steps.find((step) => step.kind === "contact")!];
    expect(FunnelStepsSchema.safeParse(contactLast).error?.issues[0]?.message).toMatch(/middle, not last/);

    const duplicateKeys = [steps[0]!, { ...steps[1]!, key: steps[0]!.key }, steps[2]!];
    expect(FunnelStepsSchema.safeParse(duplicateKeys).error?.issues.some((i) => /share the key/.test(i.message))).toBe(true);
  });

  it("creates with the default six screens, renames its slug, and refuses a slug already taken", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const funnel = await createFunnel(db, organisationId, { name: "Taxi ads", slug: "taxi-ads", clientId, actorId: "u1" });
      expect(funnel.status).toBe("draft");
      expect(funnel.steps.filter((step) => step.kind === "contact")).toHaveLength(1);
      expect(maximumScore(funnel.steps)).toBeGreaterThan(0);

      const renamed = await updateFunnel(db, organisationId, { funnelId: funnel.id, slug: "taxi-leads", actorId: "u1" });
      expect(renamed.slug).toBe("taxi-leads");
      await createFunnel(db, organisationId, { name: "Other", slug: "taxi-ads", actorId: "u1" });
      await expect(updateFunnel(db, organisationId, { funnelId: funnel.id, slug: "taxi-ads", actorId: "u1" }))
        .rejects.toThrow(/already lives at/);

      const audits = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.targetId, funnel.id)));
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["funnel.created", "funnel.updated"]));
      expect(await listFunnels(db, organisationId)).toHaveLength(2);
    });
  });

  it("only answers on the public slug once it is published, and refuses to publish a broken funnel", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const funnel = await createFunnel(db, organisationId, { name: "Enquiry", slug: "enquiry", actorId: "u1" });
      expect(await publishedFunnelBySlug(db, "enquiry")).toBeNull();

      await db.update(schema.funnels).set({ steps: funnel.steps.filter((s) => s.kind !== "contact") }).where(eq(schema.funnels.id, funnel.id));
      await expect(setFunnelStatus(db, organisationId, { funnelId: funnel.id, status: "published", actorId: "u1" }))
        .rejects.toThrow(/contact step/);

      await db.update(schema.funnels).set({ steps: funnel.steps }).where(eq(schema.funnels.id, funnel.id));
      await setFunnelStatus(db, organisationId, { funnelId: funnel.id, status: "published", actorId: "u1" });
      expect((await publishedFunnelBySlug(db, "enquiry"))?.id).toBe(funnel.id);

      await setFunnelStatus(db, organisationId, { funnelId: funnel.id, status: "archived", actorId: "u1" });
      expect(await publishedFunnelBySlug(db, "enquiry")).toBeNull();
    });
  });

  it("keeps organisations apart", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const funnel = await createFunnel(db, a.organisationId, { name: "Only A", slug: `only-a-${Date.now()}`, actorId: "u1" });
      expect(await getFunnel(db, b.organisationId, funnel.id)).toBeNull();
      expect(await listFunnels(db, b.organisationId)).toHaveLength(0);
      await expect(updateFunnel(db, b.organisationId, { funnelId: funnel.id, name: "Stolen", actorId: "u2" })).rejects.toThrow(/not one of ours/);
      await expect(answerFunnelStep(db, b.organisationId, { funnelId: funnel.id, stepKey: "goal", choice: "ads" }, env))
        .rejects.toThrow(/not one of ours/);
    });
  });
});

describe("walking a funnel", () => {
  it("creates the lead at the contact step, not at the end, and keeps the abandoned walk", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const funnel = await publishedFunnel(db, organisationId, `mid-${Date.now()}`);

      const first = await answerFunnelStep(db, organisationId, {
        funnelId: funnel.id, stepKey: "goal", choice: "ads",
        attribution: { utmSource: "google", utmMedium: "cpc", utmCampaign: "Spring Offer", gclid: "abc" },
      }, env);
      expect(first.leadId).toBeNull();
      expect(first.session.score).toBe(30);

      const second = await answerFunnelStep(db, organisationId, { funnelId: funnel.id, token: first.token, stepKey: "timing", choice: "asap" }, env);
      expect(second.session.score).toBe(60);

      // The middle screen. This is the moment the lead exists.
      const third = await answerFunnelStep(db, organisationId, {
        funnelId: funnel.id, token: first.token, stepKey: "contact",
        contact: { name: "Safiullah Mansoor", phone: "07700 900123", email: "saf@example.test", business: "Grays Town Taxis" },
      }, env);
      expect(third.leadId).not.toBeNull();
      expect(third.session.status).toBe("contacted");
      expect(third.session.contactedAt).not.toBeNull();
      expect(third.session.completedAt).toBeNull();

      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, third.leadId!));
      expect(lead).toMatchObject({ name: "Safiullah Mansoor", email: "saf@example.test", business: "Grays Town Taxis", source: "funnel" });
      // Every answer given before the contact screen is on the lead Shoji reads.
      expect(lead!.message).toContain("Someone to run my ads");
      expect(lead!.message).toContain("As soon as possible");
      // And the attribution the click carried came with it, so the campaign join works.
      expect((lead!.metadata as { attribution?: { utmCampaign?: string } }).attribution?.utmCampaign).toBe("Spring Offer");

      // Walked away here. The session is abandoned; the lead is not.
      const abandoned = await sessionByToken(db, organisationId, first.token);
      expect(abandoned?.completedAt).toBeNull();
      expect(abandoned?.leadId).toBe(third.leadId);

      const performance = await funnelPerformance(db, organisationId, { funnelId: funnel.id });
      expect(performance.funnels[0]).toMatchObject({ starts: 1, contacts: 1, completions: 0, abandonedAfterContact: 1 });
      expect(await recentFunnelSessions(db, organisationId, { funnelId: funnel.id })).toHaveLength(1);
    });
  });

  it("scores once per step when an answer is changed, buzzes the owner once when it goes hot, and completes", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const funnel = await publishedFunnel(db, organisationId, `hot-${Date.now()}`, 55);

      const start = await answerFunnelStep(db, organisationId, { funnelId: funnel.id, stepKey: "goal", choice: "ads" }, env);
      // Stepping back and answering the same question again replaces the score rather than adding to it.
      const changed = await answerFunnelStep(db, organisationId, { funnelId: funnel.id, token: start.token, stepKey: "goal", choice: "looking" }, env);
      expect(changed.session.score).toBe(-10);
      await answerFunnelStep(db, organisationId, { funnelId: funnel.id, token: start.token, stepKey: "goal", choice: "ads" }, env);

      await answerFunnelStep(db, organisationId, { funnelId: funnel.id, token: start.token, stepKey: "timing", choice: "asap" }, env);
      const contact = await answerFunnelStep(db, organisationId, {
        funnelId: funnel.id, token: start.token, stepKey: "contact", contact: { name: "Aisha", phone: "07700 900000" },
      }, env);
      expect(contact.session.score).toBe(60);

      const buzz = await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.userId, ownerUserId), eq(schema.notifications.kind, "funnel.hot_lead")));
      expect(buzz).toHaveLength(1);
      expect(buzz[0]?.link).toBe(`/leads/${contact.leadId}`);

      // A further answer does not buzz a second time.
      await answerFunnelStep(db, organisationId, { funnelId: funnel.id, token: start.token, stepKey: "budget", choice: "over-500" }, env);
      expect(await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.userId, ownerUserId), eq(schema.notifications.kind, "funnel.hot_lead")))).toHaveLength(1);

      const done = await completeFunnelSession(db, organisationId, { funnelId: funnel.id, token: start.token });
      expect(done.status).toBe("completed");
      expect(done.completedAt).not.toBeNull();
      // Completing again is a no-op, because the done page reloads.
      expect((await completeFunnelSession(db, organisationId, { funnelId: funnel.id, token: start.token })).completedAt)
        .toEqual(done.completedAt);

      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, done.leadId!));
      expect(lead!.message).toContain("Over £500");
    });
  });

  it("refuses an answer that is not one of the options, an unknown token, and a funnel that is not published", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const funnel = await publishedFunnel(db, organisationId, `refuse-${Date.now()}`);

      await expect(answerFunnelStep(db, organisationId, { funnelId: funnel.id, stepKey: "goal", choice: "made-up" }, env))
        .rejects.toThrow(/Pick one of the answers/);
      await expect(answerFunnelStep(db, organisationId, { funnelId: funnel.id, token: "f".repeat(32), stepKey: "goal", choice: "ads" }, env))
        .rejects.toThrow(/not one we recognise/);
      await expect(answerFunnelStep(db, organisationId, { funnelId: funnel.id, stepKey: "not-a-step", choice: "ads" }, env))
        .rejects.toThrow(/not part of this funnel/);
      await expect(answerFunnelStep(db, organisationId, { funnelId: funnel.id, stepKey: "contact", contact: { name: "A", phone: "07" } }, env))
        .rejects.toThrow();

      await setFunnelStatus(db, organisationId, { funnelId: funnel.id, status: "draft", actorId: "u1" });
      await expect(answerFunnelStep(db, organisationId, { funnelId: funnel.id, stepKey: "goal", choice: "ads" }, env))
        .rejects.toThrow(/not taking answers/);
    });
  });
});
