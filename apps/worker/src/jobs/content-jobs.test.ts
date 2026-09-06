import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { CONTENT_WRITER_KEY, FakeLlmClient, agentRegistry, text, toolUse } from "@launchos/agents";
import { MockEmailAdapter } from "@launchos/channels";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockCmsProvider, MockImageGenAdapter, MockSocialPublisher, createIntegrations } from "@launchos/integrations";
import { QUEUE } from "../boss.js";
import { handleContentDraft } from "./content-draft.js";
import { CONTENT_CRON, LONDON, registerContentJobs, type BossRegistrar } from "./content-jobs.js";
import { contentJobFixture, silentLogger } from "./content-test-fixture.js";

function fakeBoss() {
  const worked: string[] = [];
  const scheduled: { name: string; cron: string; tz: string | undefined }[] = [];
  const boss = {
    work: (async (name: string) => { worked.push(name); return name; }) as unknown as BossRegistrar["work"],
    schedule: (async (name: string, cron: string, _data: unknown, opts?: { tz?: string }) => {
      scheduled.push({ name, cron, tz: opts?.tz });
    }) as unknown as BossRegistrar["schedule"],
    send: (async () => "job-id") as unknown as BossRegistrar["send"],
  };
  return { boss, worked, scheduled };
}

function registry() {
  return agentRegistry({
    integrations: { ...createIntegrations({}), cms: new MockCmsProvider() },
    email: new MockEmailAdapter(),
    portalBaseUrl: "http://localhost:3000",
  });
}

describe("registerContentJobs", () => {
  it("registers a worker for every content queue and the three crons in Europe/London", async () => {
    await withTestDb(async (db) => {
      const { boss, worked, scheduled } = fakeBoss();

      await registerContentJobs({
        db, boss, social: new MockSocialPublisher(), cms: new MockCmsProvider(), imagegen: new MockImageGenAdapter(), logger: silentLogger(),
        agentRun: { db, registry: registry(), llm: new FakeLlmClient([]), policy: "safe", logger: silentLogger() },
      });

      expect(worked.sort()).toEqual(
        [QUEUE.contentDraft, QUEUE.contentPlanMonth, QUEUE.contentPublishDue, QUEUE.contentRenderImage, QUEUE.contentReport].sort(),
      );
      expect(scheduled).toEqual([
        { name: QUEUE.contentPlanMonth, cron: "0 6 1 * *", tz: LONDON },
        { name: QUEUE.contentPublishDue, cron: "*/5 * * * *", tz: LONDON },
        { name: QUEUE.contentReport, cron: "0 7 1 * *", tz: LONDON },
      ]);
      expect(Object.keys(CONTENT_CRON)).not.toContain(QUEUE.contentDraft);
      // Rendering an image is sent by a person's press and by the publish
      // sweep's backfill; a clock of its own would only redraw pictures.
      expect(Object.keys(CONTENT_CRON)).not.toContain(QUEUE.contentRenderImage);
    });
  });
});

describe("handleContentDraft", () => {
  it("runs the Content Writer for the client and month, and skips it when disabled", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const usage = { inputTokens: 1, outputTokens: 1 };
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "content_list_slots", { clientId: f.clientId, periodKey: "2026-09" })], stopReason: "tool_use", usage },
        { content: [text("Nothing to draft.")], stopReason: "end_turn", usage },
      ]);
      const deps = { db, registry: registry(), llm, policy: "safe" as const, logger: silentLogger() };
      const job = { organisationId: f.orgId, clientId: f.clientId, periodKey: "2026-09", trigger: "manual" as const };

      expect(await handleContentDraft(deps, job)).toBeUndefined();
      await db.insert(schema.agentEnablement).values({ organisationId: f.orgId, agentKey: CONTENT_WRITER_KEY, enabled: true });

      const result = await handleContentDraft(deps, job);

      expect(result?.status).toBe("completed");
      const [run] = await db.select().from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.organisationId, f.orgId), eq(schema.agentRuns.agentKey, CONTENT_WRITER_KEY)));
      expect(run!.trigger).toBe("manual");
      expect(run!.input).toEqual({ clientId: f.clientId, periodKey: "2026-09" });
    });
  });
});
