import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { mockSmsAdapter } from "@launchos/channels";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { setEnqueue } from "../events/emit.js";
import { decideApproval } from "../approvals/decide-approval.js";
import { sendQueuedMessage } from "../support/send-queued-message.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { ingestInboundEnquiry } from "./inbound-enquiry.js";
import { applyLeadReplyDecision, replyChannelFor, requestLeadReply } from "./reply.js";

setEnqueue(async () => {});

const ENV = { APP_URL: "https://os.launchflow.co.uk", SUPPORT_CONTACT_EMAIL: "hello@launchflow.test" } as NodeJS.ProcessEnv;

/** The email adapter must never be reached on this path; this proves it. */
const refusingEmail = {
  name: "must-not-be-used",
  async send(): Promise<never> {
    throw new Error("a text was sent as an email");
  },
} as never;

describe("replyChannelFor", () => {
  it("answers the way the enquiry arrived", () => {
    expect(replyChannelFor({ source: "sms", email: null, phone: "+447700900123" })).toBe("sms");
    expect(replyChannelFor({ source: "whatsapp", email: null, phone: "+447700900123" })).toBe("whatsapp");
    expect(replyChannelFor({ source: "website", email: "a@b.test", phone: null })).toBe("email");
  });

  it("would rather text a form lead than lose it to a missing address", () => {
    expect(replyChannelFor({ source: "website", email: null, phone: "+447700900123" })).toBe("sms");
  });

  it("still prefers email when they gave both", () => {
    expect(replyChannelFor({ source: "website", email: "a@b.test", phone: "+447700900123" })).toBe("email");
  });
});

describe("replying to somebody who only ever sent a text", () => {
  it("drafts, waits for approval, and then answers by text rather than failing on a missing address", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);

      const arrived = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms", from: "07700 900123",
        body: "Hi do you build websites, how much for a small one for my shop?",
      });
      expect(arrived.action).toBe("lead_created");
      if (arrived.action !== "lead_created") return;

      // This used to throw no_email — there is no address on an SMS lead.
      const { approval } = await requestLeadReply(db, organisationId, {
        leadId: arrived.leadId,
        subject: "Your website",
        body: "Happy to help — a five page site starts at £45 a month. What does the shop sell?",
        actorKind: "agent", actorId: "lead-qualifier",
      }, ENV);

      await decideApproval(db, organisationId, {
        approvalId: approval.id, decision: "approved", decidedByUserId: ownerUserId,
      });
      const applied = await applyLeadReplyDecision(db, organisationId, {
        approvalId: approval.id, actorId: ownerUserId,
      }, ENV);

      expect(applied.decision).toBe("approved");
      const message = applied.message!;
      expect(message).toMatchObject({ channel: "sms", toPhone: "+447700900123", toEmail: null, fromEmail: null, status: "queued" });

      // And it goes out through the SMS adapter, never the mail one.
      const sms = mockSmsAdapter();
      await sendQueuedMessage(db, organisationId, { messageId: message.id }, refusingEmail, ENV, sms);
      expect(sms.sent).toHaveLength(1);
      expect(sms.sent[0]!.to).toBe("+447700900123");
      expect(sms.sent[0]!.body).toContain("£45 a month");

      // The mock did not deliver, so the row must not claim it was sent.
      const [after] = await db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
      expect(after!.status).toBe("queued");
      expect(after!.deliveredAt).toBeNull();
    });
  });

  it("refuses to send a text with no adapter rather than quietly emailing it", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const arrived = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms", from: "07700 900124", body: "how much for a website for my cafe please",
      });
      if (arrived.action !== "lead_created") throw new Error("expected a lead");

      const { approval } = await requestLeadReply(db, organisationId, {
        leadId: arrived.leadId, subject: "Your website", body: "Happy to help.", actorKind: "agent",
      }, ENV);
      await decideApproval(db, organisationId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerUserId });
      const applied = await applyLeadReplyDecision(db, organisationId, { approvalId: approval.id, actorId: ownerUserId }, ENV);

      await expect(
        sendQueuedMessage(db, organisationId, { messageId: applied.message!.id }, refusingEmail, ENV),
      ).rejects.toThrow(/no SMS adapter/);
    });
  });
});
