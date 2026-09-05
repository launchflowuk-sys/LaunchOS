import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { MockEmailAdapter } from "@launchos/channels";
import { and, eq, not } from "drizzle-orm";
import { createClient } from "../clients/create-client.js";
import { DEFAULT_FIRST_RESPONSE_HOURS } from "../config.js";
import { ensureEmailIdentity } from "../email/ensure-email-identity.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { acknowledgementBody, caseReference, queueCaseAcknowledgement } from "./acknowledge-ticket.js";
import { CASE_ACKNOWLEDGEMENT_KIND, isCourtesyNotice } from "./courtesy-notice.js";
import { createTicket } from "./create-ticket.js";
import { ingestInboundEmail } from "./ingest-inbound-email.js";
import { sendQueuedMessage } from "./send-queued-message.js";

const ENV = { APP_URL: "https://os.launchflow.test", SUPPORT_EMAIL_DOMAIN: "support.test", MAIL_FROM: "support@launchflow.test" };

async function withCapturedEvents<T>(run: (events: DomainEvent[]) => Promise<T>): Promise<T> {
  const events: DomainEvent[] = [];
  setEnqueue(async (event) => {
    events.push(event);
  });
  try {
    return await run(events);
  } finally {
    setEnqueue(async () => {});
  }
}

async function seedOrganisation(db: Db, metadata: Record<string, unknown> = {}) {
  const [org] = await db.insert(schema.organisations)
    .values({ name: "T", slug: `ack-${crypto.randomUUID()}`, metadata }).returning();
  return org!;
}

/** A portal user for the client, so the acknowledgement has somebody to go to. */
async function seedPortalUser(db: Db, organisationId: string, clientId: string, email: string) {
  const userId = crypto.randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Jo", email, emailVerified: true });
  await db.insert(schema.clientUsers).values({ organisationId, clientId, userId, role: "client_admin" });
  return userId;
}

function acknowledgements(db: Db, conversationId: string) {
  return db.select().from(schema.messages).where(and(
    eq(schema.messages.conversationId, conversationId),
    isCourtesyNotice(),
  ));
}

describe("queueCaseAcknowledgement", () => {
  it("queues one branded acknowledgement to the portal user who raised the case", async () => {
    await withTestDb(async (db) => {
      await withCapturedEvents(async (events) => {
        const org = await seedOrganisation(db);
        const client = await createClient(db, org.id, { name: "Grays CabLine" });
        const userId = await seedPortalUser(db, org.id, client.id, "jo@grays.test");
        events.length = 0;

        const { ticket, conversation, acknowledgement } = await createTicket(db, org.id, {
          clientId: client.id, subject: "Contact form is down", body: "Nothing arrives.",
          severity: "medium", source: "portal", actorKind: "client", actorId: userId,
        }, ENV);

        expect(acknowledgement).toBeDefined();
        expect(acknowledgement!.toEmail).toBe("jo@grays.test");
        expect(acknowledgement!.direction).toBe("outbound");
        expect(acknowledgement!.authorKind).toBe("system");
        expect(acknowledgement!.status).toBe("queued");
        expect(acknowledgement!.metadata).toMatchObject({ kind: CASE_ACKNOWLEDGEMENT_KIND, ticketId: ticket.id });
        expect(acknowledgement!.body).toBe(acknowledgementBody(ticket, DEFAULT_FIRST_RESPONSE_HOURS));
        expect(acknowledgement!.body).toContain(`'Contact form is down' is open as #${caseReference(ticket.id)}`);
        expect(acknowledgement!.body).toContain(`within ${DEFAULT_FIRST_RESPONSE_HOURS} hours (working hours)`);

        // Handed to the worker only after the ticket committed.
        expect(events.map((e) => e.name)).toEqual(["ticket.created", "message.queued"]);

        // It is a record of an email, not a turn in the thread: every reader
        // filters on `isCourtesyNotice`, and the thread proper is still one
        // inbound message.
        const thread = await db.select().from(schema.messages).where(and(
          eq(schema.messages.conversationId, conversation.id),
          not(isCourtesyNotice()),
        ));
        expect(thread.map((m) => m.direction)).toEqual(["inbound"]);

        // An automatic acknowledgement is not a first response.
        const [after] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
        expect(after!.firstResponseAt).toBeNull();
        expect(after!.metadata["acknowledgedAt"]).toEqual(expect.any(String));
      });
    });
  });

  it("renders the branded email with its own heading and a link to the case", async () => {
    await withTestDb(async (db) => {
      const org = await seedOrganisation(db);
      const client = await createClient(db, org.id, { name: "Grays CabLine" });
      const userId = await seedPortalUser(db, org.id, client.id, "jo@grays.test");
      const { ticket, acknowledgement } = await createTicket(db, org.id, {
        clientId: client.id, subject: "Contact form is down", body: "Nothing arrives.",
        severity: "medium", source: "portal", actorKind: "client", actorId: userId,
      }, ENV);

      const adapter = new MockEmailAdapter();
      const sent = await sendQueuedMessage(db, org.id, { messageId: acknowledgement!.id }, adapter, ENV);

      expect(sent.status).toBe("sent");
      const [mail] = adapter.sent;
      expect(mail!.to).toBe("jo@grays.test");
      expect(mail!.html).toContain("We&#39;ve got your request");
      expect(mail!.html).toContain("View your case");
      expect(mail!.html).toContain(`https://os.launchflow.test/portal/support/${ticket.id}`);
      expect(mail!.text).toContain(`#${caseReference(ticket.id)}`);
    });
  });

  it("quotes the organisation's own first-response hours when it has set them", async () => {
    await withTestDb(async (db) => {
      const org = await seedOrganisation(db, { firstResponseHours: 2 });
      const client = await createClient(db, org.id, { name: "C", email: "office@c.test" });

      // No portal user resolves for this actor, so the client record's own
      // address is the requester.
      const { acknowledgement } = await createTicket(db, org.id, {
        clientId: client.id, subject: "Slow site", body: "Takes ages.",
        severity: "low", source: "portal", actorKind: "client", actorId: "not-a-user-id",
      }, ENV);

      expect(acknowledgement!.toEmail).toBe("office@c.test");
      expect(acknowledgement!.body).toContain("within 2 hours (working hours)");
    });
  });

  it("acknowledges an emailed case to its sender, threaded under their message", async () => {
    await withTestDb(async (db) => {
      await withCapturedEvents(async (events) => {
        const org = await seedOrganisation(db);
        const client = await createClient(db, org.id, { name: "C" });
        const identity = await ensureEmailIdentity(db, org.id, { clientId: client.id }, ENV);
        const messageId = `<in-${crypto.randomUUID()}@client.test>`;
        events.length = 0;

        const result = await ingestInboundEmail(db, org.id, {
          provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Site is down", text: "503",
          messageId, references: [], attachments: [], rawHeaders: {},
        }, ENV);

        const notices = await acknowledgements(db, result.conversation.id);
        expect(notices).toHaveLength(1);
        expect(notices[0]!.toEmail).toBe("jo@client.test");
        expect(notices[0]!.fromEmail).toBe(identity.address);
        expect(notices[0]!.subject).toBe("Re: Site is down");
        expect(notices[0]!.rawHeaders).toEqual({ "in-reply-to": messageId });
        expect(events.map((e) => e.name)).toEqual(["ticket.created", "message.queued"]);

        // A redelivery of the same payload does not acknowledge again.
        events.length = 0;
        await ingestInboundEmail(db, org.id, {
          provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Site is down", text: "503",
          messageId, references: [], attachments: [], rawHeaders: {},
        }, ENV);
        expect(await acknowledgements(db, result.conversation.id)).toHaveLength(1);
        expect(events).toEqual([]);
      });
    });
  });

  it("stays silent for a case staff, a monitor or an agent opened, and for an unmatched sender", async () => {
    await withTestDb(async (db) => {
      const org = await seedOrganisation(db);
      const client = await createClient(db, org.id, { name: "C", email: "office@c.test" });

      for (const [source, actorKind] of [["manual", "user"], ["monitor", "system"], ["agent", "agent"]] as const) {
        const { conversation, acknowledgement } = await createTicket(db, org.id, {
          clientId: client.id, subject: `Raised by ${source}`, body: "About the client, not by them.",
          severity: "medium", source, actorKind, actorId: "u1",
        }, ENV);
        expect(acknowledgement).toBeUndefined();
        expect(await acknowledgements(db, conversation.id)).toHaveLength(0);
      }

      // Mail to an address we do not route lands under the holding client,
      // whose sender we cannot vouch for: no acknowledgement.
      const unmatched = await ingestInboundEmail(db, org.id, {
        provider: "generic", to: ["nobody@support.test"], from: "stranger@else.test", subject: "Hello?", text: "Hi",
        messageId: `<in-${crypto.randomUUID()}@else.test>`, references: [], attachments: [], rawHeaders: {},
      }, ENV);
      expect(unmatched.matched).toBe(false);
      expect(await acknowledgements(db, unmatched.conversation.id)).toHaveLength(0);
    });
  });

  it("never sends twice for one ticket", async () => {
    await withTestDb(async (db) => {
      const org = await seedOrganisation(db);
      const client = await createClient(db, org.id, { name: "C" });
      const userId = await seedPortalUser(db, org.id, client.id, "jo@grays.test");
      const { ticket, conversation } = await createTicket(db, org.id, {
        clientId: client.id, subject: "Twice?", body: "Once, please.",
        severity: "medium", source: "portal", actorKind: "client", actorId: userId,
      }, ENV);

      const [fresh] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
      const again = await queueCaseAcknowledgement(db, org.id, {
        ticket: fresh!, conversation, actorKind: "client", actorId: userId,
      }, ENV);
      expect(again).toBeUndefined();

      // Even with the ticket stamp missing, the message's own `ticketId` guards it.
      const unstamped = { ...fresh!, metadata: {} };
      const third = await queueCaseAcknowledgement(db, org.id, {
        ticket: unstamped, conversation, actorKind: "client", actorId: userId,
      }, ENV);
      expect(third).toBeUndefined();
      expect(await acknowledgements(db, conversation.id)).toHaveLength(1);
    });
  });
});
