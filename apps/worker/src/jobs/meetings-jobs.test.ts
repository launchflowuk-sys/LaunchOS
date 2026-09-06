import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { bookMeeting, createLead } from "@launchos/core";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockMeetingsAdapter } from "@launchos/integrations";
import { QUALIFIED_LEAD_SOURCES, dispatchEvent, type BossSender } from "./dispatch-event.js";
import { ensureLeadQualifierEnabled } from "./lead-enablement.js";
import { MEETING_CRON, registerMeetingJobs, runMeetingFollowUps, runMeetingReminders } from "./meetings-jobs.js";

const env = { APP_URL: "https://os.launchflow.test" } as NodeJS.ProcessEnv;
const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-09-07T10:00:00Z");
const TUE_13 = new Date("2026-09-08T12:00:00Z");

async function org(db: Parameters<typeof createLead>[0]) {
  const [row] = await db.insert(schema.organisations).values({ name: "T", slug: `mj-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: row!.id, userId: ownerId, role: "owner", status: "active" });
  return { organisationId: row!.id, ownerId };
}

describe("lead.created dispatch", () => {
  it("starts the Lead Qualifier for a website lead with an email, keyed by lead, and not for manual, signup, booking or address-less leads", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await org(db);
      const send = vi.fn(async () => "job");
      const boss = { send } as unknown as BossSender;
      const lead = await createLead(db, organisationId, { name: "A", email: "a@example.test", source: "website" }, env);
      await dispatchEvent({ db, boss }, { name: "lead.created", organisationId, leadId: lead.id });
      expect(send).toHaveBeenCalledWith(
        "agent.run",
        { agentKey: "lead-qualifier", organisationId, trigger: "event", payload: { leadId: lead.id } },
        { singletonKey: `lead-qualifier:${lead.id}` },
      );
      send.mockClear();
      for (const input of [
        { name: "M", email: "m@example.test", source: "manual" },
        { name: "S", email: "s@example.test", source: "signup", acknowledge: false },
        { name: "B", email: "b@example.test", source: "booking", acknowledge: false },
        { name: "N", source: "website" },
      ]) {
        const l = await createLead(db, organisationId, input, env);
        await dispatchEvent({ db, boss }, { name: "lead.created", organisationId, leadId: l.id });
      }
      await dispatchEvent({ db, boss }, { name: "lead.created", organisationId, leadId: randomUUID() });
      expect(send).not.toHaveBeenCalled();
      expect(QUALIFIED_LEAD_SOURCES).toContain("website");
      expect(QUALIFIED_LEAD_SOURCES).not.toContain("signup");
    });
  });

  it("enables the qualifier once per organisation and never overrides a decision", async () => {
    await withTestDb(async (db) => {
      const a = await org(db);
      const b = await org(db);
      await db.insert(schema.agentEnablement).values({ organisationId: b.organisationId, agentKey: "lead-qualifier", enabled: false });
      const first = await ensureLeadQualifierEnabled(db, quiet);
      expect(first.enabled).toBeGreaterThanOrEqual(1);
      const [rowA] = await db.select().from(schema.agentEnablement)
        .where(and(eq(schema.agentEnablement.organisationId, a.organisationId), eq(schema.agentEnablement.agentKey, "lead-qualifier")));
      expect(rowA!.enabled).toBe(true);
      const [rowB] = await db.select().from(schema.agentEnablement)
        .where(and(eq(schema.agentEnablement.organisationId, b.organisationId), eq(schema.agentEnablement.agentKey, "lead-qualifier")));
      expect(rowB!.enabled).toBe(false);
      expect((await ensureLeadQualifierEnabled(db, quiet)).enabled).toBe(0);
    });
  });
});

describe("meeting jobs", () => {
  it("registers two workers and two London crons", async () => {
    const work = vi.fn(async () => "w");
    const schedule = vi.fn(async () => undefined);
    const boss = { work, schedule, send: vi.fn() } as unknown as Parameters<typeof registerMeetingJobs>[0]["boss"];
    await registerMeetingJobs({ db: {} as never, boss, env, logger: quiet });
    expect(work.mock.calls.map((c) => c[0])).toEqual(["meetings.remind", "meetings.follow-up"]);
    expect(schedule.mock.calls).toEqual([
      ["meetings.remind", "*/10 * * * *", {}, { tz: "Europe/London" }],
      ["meetings.follow-up", "0 9 * * *", {}, { tz: "Europe/London" }],
    ]);
    expect(MEETING_CRON["meetings.remind"]).toBe("*/10 * * * *");
  });

  it("sweeps every organisation for reminders and follow-ups, totalling what was sent", async () => {
    await withTestDb(async (db) => {
      const a = await org(db);
      const b = await org(db);
      const meetings = new MockMeetingsAdapter();
      const one = await bookMeeting(db, a.organisationId, { guestName: "A", guestEmail: "a@example.test", startsAt: TUE_13, now: NOW }, { meetings }, env);
      await bookMeeting(db, b.organisationId, { guestName: "B", guestEmail: "b@example.test", startsAt: TUE_13, now: NOW }, { meetings }, env);

      const dayBefore = new Date(TUE_13.getTime() - 20 * 3_600_000);
      const reminders = await runMeetingReminders({ db, env, logger: quiet }, dayBefore);
      expect(reminders).toMatchObject({ reminded24h: 2, reminded1h: 0, hostAlerted: 0 });
      expect(reminders.organisations).toBeGreaterThanOrEqual(2);
      expect((await runMeetingReminders({ db, env, logger: quiet }, dayBefore)).reminded24h).toBe(0);

      const afterwards = new Date(TUE_13.getTime() + 4 * 3_600_000);
      const followUps = await runMeetingFollowUps({ db, env, logger: quiet }, afterwards);
      expect(followUps).toMatchObject({ outcomeNudged: 2, noShowEmailed: 0 });
      const [nudge] = await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.userId, a.ownerId), eq(schema.notifications.kind, "meeting.outcome_needed")));
      expect(nudge!.link).toBe(`/meetings/${one.meeting.id}`);
    });
  });
});
