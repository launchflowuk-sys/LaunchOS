import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { FakeLlmClient, OPS_BRIEF_KEY, agentRegistry, text, toolUse } from "@launchos/agents";
import { MockEmailAdapter } from "@launchos/channels";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockCmsProvider, createIntegrations } from "@launchos/integrations";
import { QUEUE } from "../boss.js";
import { LONDON, type BossRegistrar } from "./content-jobs.js";
import {
  OPS_BRIEF_CRON,
  OPS_BRIEF_LINK,
  OPS_BRIEF_NOTIFICATION_KIND,
  OPS_BRIEF_NOTIFIED_AT,
  briefDateLabel,
  briefToParagraphs,
  ensureOpsBriefEnabled,
  registerOpsBriefJob,
  runOpsBriefFor,
} from "./ops-brief.js";

// The tools stamp the brief with the *run's* clock (`ctx.now()`), which
// `handleAgentRun` leaves as the real one, so the date under test is today's
// London date rather than a pinned one.
const NOW = new Date();
const TODAY = NOW.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const usage = { inputTokens: 1, outputTokens: 1 };
const quiet = { info() {}, warn() {}, error() {} };
const warnings: unknown[] = [];
const recording = { info() {}, warn(...args: unknown[]) { warnings.push(args); }, error() {} };

const BODY = "## Yesterday\nQuiet day.\n## Needs you today\n- Approve 1 post — [Approvals](/approvals)\n## Team\n8 hours clocked.\n## Money\nNothing due.";

async function org(db: Db, enabled = true) {
  const [row] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `lf-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: row!.id, userId: ownerId, role: "owner" });
  await db.insert(schema.agentEnablement).values({ organisationId: row!.id, agentKey: OPS_BRIEF_KEY, enabled });
  return { organisationId: row!.id, ownerId };
}

function registry(email: MockEmailAdapter) {
  return agentRegistry({ integrations: { ...createIntegrations({}), cms: new MockCmsProvider() }, email, portalBaseUrl: "http://localhost:3000" });
}

function savingLlm() {
  return new FakeLlmClient([
    { content: [toolUse("t1", "ops_metrics_snapshot", { hours: 24 })], stopReason: "tool_use", usage },
    { content: [toolUse("t2", "ops_save_brief", { bodyMd: BODY, highlights: [{ label: "Approve 1 post", link: "/approvals" }] })], stopReason: "tool_use", usage },
    { content: [text("Brief saved.")], stopReason: "end_turn", usage },
  ]);
}

function deps(db: Db, llm: FakeLlmClient, env: NodeJS.ProcessEnv, email = new MockEmailAdapter()) {
  return {
    db, email, env,
    agentRun: { db, registry: registry(email), llm, policy: "safe" as const, logger: quiet as unknown as Console },
    logger: recording,
  };
}

function fakeBoss() {
  const worked: string[] = [];
  const scheduled: { name: string; cron: string; tz: string | undefined }[] = [];
  const boss = {
    work: (async (name: string) => { worked.push(name); return name; }) as unknown as BossRegistrar["work"],
    schedule: (async (name: string, cron: string, _data: unknown, opts?: { tz?: string }) => { scheduled.push({ name, cron, tz: opts?.tz }); }) as unknown as BossRegistrar["schedule"],
    send: (async () => "job-id") as unknown as BossRegistrar["send"],
  };
  return { boss, worked, scheduled };
}

describe("briefToParagraphs / briefDateLabel", () => {
  it("turns headings, bullets and admin links into escaped-safe paragraphs with absolute links", () => {
    expect(briefToParagraphs(BODY, "https://os.example.test")).toEqual([
      "Yesterday",
      "Quiet day.",
      "Needs you today",
      "• Approve 1 post — Approvals (https://os.example.test/approvals)",
      "Team",
      "8 hours clocked.",
      "Money",
      "Nothing due.",
    ]);
    expect(briefToParagraphs("Line one\nLine **two**\n\n[Site](https://a.test/x)", "https://os.example.test")).toEqual([
      "Line one\nLine two",
      "Site (https://a.test/x)",
    ]);
    expect(briefDateLabel("2026-09-09")).toBe("Wednesday 9 September 2026");
  });
});

describe("ensureOpsBriefEnabled", () => {
  it("switches the brief on for an organisation that has never decided and leaves a decision alone", async () => {
    await withTestDb(async (db) => {
      const [fresh] = await db.insert(schema.organisations).values({ name: "Fresh", slug: `fresh-${randomUUID()}` }).returning();
      const off = await org(db, false);
      const first = await ensureOpsBriefEnabled(db, quiet);
      expect(first.enabled).toBeGreaterThanOrEqual(1);
      const row = async (id: string) => (await db.select().from(schema.agentEnablement)
        .where(and(eq(schema.agentEnablement.organisationId, id), eq(schema.agentEnablement.agentKey, OPS_BRIEF_KEY))))[0];
      expect((await row(fresh!.id))?.enabled).toBe(true);
      expect((await row(off.organisationId))?.enabled).toBe(false);
      expect((await ensureOpsBriefEnabled(db, quiet)).enabled).toBe(0);
    });
  });
});

describe("registerOpsBriefJob", () => {
  it("registers the worker and the 07:00 Europe/London cron", async () => {
    await withTestDb(async (db) => {
      const { boss, worked, scheduled } = fakeBoss();
      await registerOpsBriefJob({ ...deps(db, savingLlm(), {}), boss });
      expect(worked).toEqual([QUEUE.opsBrief]);
      expect(scheduled).toEqual([{ name: QUEUE.opsBrief, cron: "0 7 * * *", tz: LONDON }]);
      expect(OPS_BRIEF_CRON).toBe("0 7 * * *");
    });
  });
});

describe("runOpsBriefFor", () => {
  it("runs the agent, then rings the owner's bell and emails OWNER_NOTIFY_EMAIL the branded internal brief, once", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerId } = await org(db);
      const email = new MockEmailAdapter();
      const d = deps(db, savingLlm(), { OWNER_NOTIFY_EMAIL: "shoji@example.test", MAIL_FROM: "LaunchOS <os@example.test>", APP_URL: "https://os.example.test" }, email);

      const result = await runOpsBriefFor(d, organisationId, { now: NOW, trigger: "cron" });
      expect(result.outcome).toBe("notified");
      expect(result.emailedTo).toBe("shoji@example.test");

      const [brief] = await db.select().from(schema.opsBriefs).where(eq(schema.opsBriefs.organisationId, organisationId));
      expect(brief).toMatchObject({ briefDate: TODAY, bodyMd: BODY, agentRunId: result.runId });
      expect(brief!.metadata).toMatchObject({ [OPS_BRIEF_NOTIFIED_AT]: NOW.toISOString(), emailedTo: "shoji@example.test" });

      const bells = await db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, organisationId));
      expect(bells).toHaveLength(1);
      expect(bells[0]).toMatchObject({
        userId: ownerId, kind: OPS_BRIEF_NOTIFICATION_KIND, title: `Ops Brief for ${briefDateLabel(TODAY)}`, body: "Needs you: Approve 1 post.", link: OPS_BRIEF_LINK,
      });

      expect(email.sent).toHaveLength(1);
      const sent = email.sent[0]!;
      expect(sent.to).toBe("shoji@example.test");
      expect(sent.from).toBe("LaunchOS <os@example.test>");
      expect(sent.subject).toBe(`Ops Brief — ${briefDateLabel(TODAY)}`);
      expect(sent.text).toContain("Approvals (https://os.example.test/approvals)");
      expect(sent.text).toContain("Open in LaunchOS: https://os.example.test/briefs");
      // The internal variant: the compact card, and Markdown arrives as text, never as markup.
      expect(sent.html).toContain("max-width:520px");
      expect(sent.html).toContain("Quiet day.");
      expect(sent.html).not.toContain("## Yesterday");

      // A retried delivery finds the stamp and tells nobody twice — the run that
      // saved the brief is the one it is bound to, so the LLM does not run again.
      const again = await runOpsBriefFor(
        { ...d, agentRun: { ...d.agentRun, llm: new FakeLlmClient([{ content: [text("Nothing to add.")], stopReason: "end_turn", usage }]) } },
        organisationId, { now: NOW },
      );
      expect(again.outcome).toBe("no_brief");
      expect((await db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, organisationId))).length).toBe(1);
      expect(email.sent).toHaveLength(1);
    });
  });

  it("rings the bell only when OWNER_NOTIFY_EMAIL is unset, and survives a mail failure", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await org(db);
      const email = new MockEmailAdapter();
      const noEmail = await runOpsBriefFor(deps(db, savingLlm(), {}, email), organisationId, { now: NOW });
      expect(noEmail.outcome).toBe("notified");
      expect(noEmail.emailedTo).toBeUndefined();
      expect(email.sent).toHaveLength(0);
      const [brief] = await db.select().from(schema.opsBriefs).where(eq(schema.opsBriefs.organisationId, organisationId));
      expect(brief!.metadata).toMatchObject({ [OPS_BRIEF_NOTIFIED_AT]: NOW.toISOString() });
      expect(brief!.metadata).not.toHaveProperty("emailedTo");

      // A re-run replaces the brief (and clears the stamp), so the owner is told again; the mail server is down.
      const broken = { name: "mock" as const, sent: [], send: async () => { throw new Error("smtp down"); } };
      const rerun = await runOpsBriefFor(
        deps(db, savingLlm(), { OWNER_NOTIFY_EMAIL: "shoji@example.test" }, broken as unknown as MockEmailAdapter),
        organisationId, { now: new Date(NOW.getTime() + 60_000), trigger: "manual" },
      );
      expect(rerun.outcome).toBe("notified");
      expect(rerun.emailedTo).toBeUndefined();
      const bells = await db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, organisationId));
      expect(bells).toHaveLength(2);
      const briefs = await db.select().from(schema.opsBriefs).where(eq(schema.opsBriefs.organisationId, organisationId));
      expect(briefs).toHaveLength(1);
      expect(briefs[0]!.metadata).not.toHaveProperty("emailedTo");
    });
  });

  it("skips a disabled organisation and reports a run that saved nothing", async () => {
    await withTestDb(async (db) => {
      const off = await org(db, false);
      const skipped = await runOpsBriefFor(deps(db, savingLlm(), {}), off.organisationId, { now: NOW });
      expect(skipped).toEqual({ organisationId: off.organisationId, outcome: "skipped" });
      expect(await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.organisationId, off.organisationId))).toHaveLength(0);

      const on = await org(db);
      warnings.length = 0;
      const llm = new FakeLlmClient([{ content: [text("I have nothing to report.")], stopReason: "end_turn", usage }]);
      const empty = await runOpsBriefFor(deps(db, llm, { OWNER_NOTIFY_EMAIL: "shoji@example.test" }), on.organisationId, { now: NOW });
      expect(empty.outcome).toBe("no_brief");
      expect(warnings).toHaveLength(1);
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, on.organisationId))).toHaveLength(0);
    });
  });
});
