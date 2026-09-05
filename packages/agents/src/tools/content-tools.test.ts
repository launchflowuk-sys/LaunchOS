import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getContentItem, requestContentApproval } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { PERIOD, writerFixture } from "../agents/content-writer/fixture.js";
import { buildContext } from "../kernel/run-loop.js";
import { contentGetBrief } from "./content-get-brief.js";
import { contentListSlots } from "./content-list-slots.js";
import { contentRequestApproval } from "./content-request-approval.js";
import { contentSaveDraft } from "./content-save-draft.js";
import { CONTENT_WRITER_KEY, GBP_MAX_BODY_CHARS } from "./content-shared.js";

async function ctxFor(db: Db, orgId: string) {
  const [run] = await db.insert(schema.agentRuns)
    .values({ organisationId: orgId, agentKey: CONTENT_WRITER_KEY, trigger: "cron" }).returning();
  return buildContext(db, orgId, run!.id, { info() {}, warn() {}, error() {} });
}

const slotOf = (planned: { channel: string; id: string }[], channel: string) => planned.find((p) => p.channel === channel)!;

describe("content_get_brief", () => {
  it("returns the brief, the client, its sites and connected channels from our own rows", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db, { plan: false });
      const out = await contentGetBrief.execute({ clientId: f.clientId }, await ctxFor(db, f.orgId));
      expect(out.found).toBe(true);
      if (!out.found) return;
      expect(out.client.name).toBe("Grays CabLine");
      expect(out.client.websiteUrl).toBe("https://grayscabline.co.uk");
      expect(out.brief).toMatchObject({ tone: "Friendly, plain, local", offers: "10% off first airport booking", doNotSay: "cheapest" });
      expect(out.sites.map((s) => s.primaryUrl)).toEqual(["https://grayscabline.co.uk"]);
      expect(out.channels.map((c) => c.channel).sort()).toEqual(["blog", "facebook"]);
    });
  });

  it("returns a null brief when none has been written, and refuses another organisation's client", async () => {
    await withTestDb(async (db) => {
      const mine = await writerFixture(db, { brief: false, plan: false });
      const theirs = await writerFixture(db, { plan: false });
      const ctx = await ctxFor(db, mine.orgId);
      const out = await contentGetBrief.execute({ clientId: mine.clientId }, ctx);
      expect(out.found && out.brief).toBeNull();
      const foreign = await contentGetBrief.execute({ clientId: theirs.clientId }, ctx);
      expect(foreign.found).toBe(false);
    });
  });
});

describe("content_list_slots", () => {
  it("lists the planned month and marks the empty drafts unfilled", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const ctx = await ctxFor(db, f.orgId);
      const before = await contentListSlots.execute({ clientId: f.clientId, periodKey: PERIOD }, ctx);
      expect(before.slots).toHaveLength(4);
      expect(before.unfilled).toBe(4);
      expect(before.slots.map((s) => s.channel).sort()).toEqual(["blog", "facebook", "gbp", "instagram"]);
      expect(before.slots.every((s) => s.scheduledFor !== null)).toBe(true);

      await contentSaveDraft.execute({ itemId: slotOf(f.planned, "facebook").id, body: "Airport run booked in a minute." }, ctx);
      const after = await contentListSlots.execute({ clientId: f.clientId, periodKey: PERIOD }, ctx);
      expect(after.unfilled).toBe(3);
      expect(after.slots.find((s) => s.channel === "facebook")).toMatchObject({ unfilled: false, hasBody: true });
      // Another month is another list.
      expect((await contentListSlots.execute({ clientId: f.clientId, periodKey: "2026-10" }, ctx)).slots).toEqual([]);
    });
  });
});

describe("content_save_draft", () => {
  it("writes the draft onto the slot, attributed to the writer, and is a safe tool", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const ctx = await ctxFor(db, f.orgId);
      expect(contentSaveDraft.risk).toBe("safe");
      const slot = slotOf(f.planned, "facebook");

      const out = await contentSaveDraft.execute({
        itemId: slot.id, body: "Stansted at 4am? We do that.", imagePrompt: "A black cab at dawn", linkUrl: "https://grayscabline.co.uk/airport",
      }, ctx);
      expect(out).toMatchObject({ saved: true, itemId: slot.id, channel: "facebook", status: "draft" });

      const item = await getContentItem(db, f.orgId, { itemId: slot.id });
      expect(item).toMatchObject({
        body: "Stansted at 4am? We do that.", imagePrompt: "A black cab at dawn", linkUrl: "https://grayscabline.co.uk/airport",
      });
      const [audit] = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "content_item.updated"), eq(schema.auditLog.targetId, slot.id)));
      expect([audit!.actorKind, audit!.actorId]).toEqual(["agent", CONTENT_WRITER_KEY]);
    });
  });

  it("refuses a blog post without a title and a GBP update over the limit, as data rather than a throw", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const ctx = await ctxFor(db, f.orgId);

      const blog = await contentSaveDraft.execute({ itemId: slotOf(f.planned, "blog").id, body: "## Heading\nBody" }, ctx);
      expect(blog).toMatchObject({ saved: false, reason: expect.stringMatching(/needs a title/) });

      const gbp = await contentSaveDraft.execute({ itemId: slotOf(f.planned, "gbp").id, body: "x".repeat(GBP_MAX_BODY_CHARS + 1) }, ctx);
      expect(gbp).toMatchObject({ saved: false, reason: expect.stringMatching(/1500/) });

      const fine = await contentSaveDraft.execute({ itemId: slotOf(f.planned, "gbp").id, body: "y".repeat(GBP_MAX_BODY_CHARS) }, ctx);
      expect(fine.saved).toBe(true);
    });
  });

  it("refuses a slot that is no longer a draft, and another organisation's slot", async () => {
    await withTestDb(async (db) => {
      const mine = await writerFixture(db);
      const theirs = await writerFixture(db);
      const ctx = await ctxFor(db, mine.orgId);
      const slot = slotOf(mine.planned, "facebook");
      await contentSaveDraft.execute({ itemId: slot.id, body: "First." }, ctx);
      await requestContentApproval(db, mine.orgId, { itemId: slot.id, actorKind: "agent", actorId: CONTENT_WRITER_KEY });
      await db.update(schema.contentItems).set({ status: "approved" }).where(eq(schema.contentItems.id, slot.id));

      const locked = await contentSaveDraft.execute({ itemId: slot.id, body: "Second." }, ctx);
      expect(locked).toMatchObject({ saved: false, reason: expect.stringMatching(/cannot be edited/) });

      const foreign = await contentSaveDraft.execute({ itemId: slotOf(theirs.planned, "facebook").id, body: "Theirs." }, ctx);
      expect(foreign).toMatchObject({ saved: false, reason: expect.stringMatching(/No such slot/) });
      const untouched = await getContentItem(db, theirs.orgId, { itemId: slotOf(theirs.planned, "facebook").id });
      expect(untouched!.body).toBeNull();
    });
  });
});

describe("content_request_approval", () => {
  it("raises the run-less content_publish card and moves the slot to awaiting_approval", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const ctx = await ctxFor(db, f.orgId);
      const slot = slotOf(f.planned, "facebook");
      await contentSaveDraft.execute({ itemId: slot.id, body: "Book your airport run today." }, ctx);

      const out = await contentRequestApproval.execute({ itemId: slot.id }, ctx);
      expect(out.requested).toBe(true);
      if (!out.requested) return;
      expect(out.status).toBe("awaiting_approval");
      expect(out.summary).toContain("Publish Facebook post for Grays CabLine");

      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, out.approvalId));
      expect(approval!.kind).toBe("content_publish");
      expect(approval!.status).toBe("pending");
      // No run behind it: the web action applies the decision itself instead
      // of queueing a resume for a run that has nothing left to do.
      expect(approval!.runId).toBeNull();
      expect(approval!.payload).toMatchObject({ action: "content_publish", itemId: slot.id, body: "Book your airport run today." });
      expect((approval!.payload as { requestedById: string }).requestedById).toBe(CONTENT_WRITER_KEY);
    });
  });

  it("answers with a reason for an empty slot and for one already waiting", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const ctx = await ctxFor(db, f.orgId);
      const slot = slotOf(f.planned, "gbp");

      const empty = await contentRequestApproval.execute({ itemId: slot.id }, ctx);
      expect(empty).toMatchObject({ requested: false, reason: expect.stringMatching(/Write the post/) });

      await contentSaveDraft.execute({ itemId: slot.id, body: "Open 24 hours." }, ctx);
      expect((await contentRequestApproval.execute({ itemId: slot.id }, ctx)).requested).toBe(true);
      const again = await contentRequestApproval.execute({ itemId: slot.id }, ctx);
      expect(again).toMatchObject({ requested: false, reason: expect.stringMatching(/awaiting approval/) });
    });
  });
});
