import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import type { PaymentsWebhookEvent } from "@launchos/integrations";
import { checkoutOrganisationFromEvent, syncFromPaymentsEvent } from "../billing/webhook-sync.js";
import { setEnqueue } from "../events/emit.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { CHECKOUT_PAID_SESSION_ID, PROPOSAL_CHECKOUT_MARKER, completeProposalCheckout } from "./checkout.js";
import { createProposal } from "./crud.js";
import { ProposalRefused } from "./shared.js";

setEnqueue(async () => {});

const NOW = new Date("2026-09-07T10:00:00Z");
const CUSTOMER = "cus_p5proposal";
const SUBSCRIPTION = "sub_p5proposal";

async function acceptedProposal(db: Db) {
  const seeded = await seedOrgWithClient(db);
  await db.update(schema.packages)
    .set({ stripePriceId: "price_care", monthlyPricePence: 25_000 })
    .where(eq(schema.packages.id, seeded.packageId));
  const detail = await createProposal(db, seeded.organisationId, {
    clientId: seeded.clientId,
    title: "Website and care plan",
    pricing: { shape: "setup_plus_monthly", packageId: seeded.packageId, vatNote: "" },
    lines: [
      { kind: "setup", description: "Build", unitPence: 120_000 },
      { kind: "monthly", description: "Care plan", unitPence: 25_000 },
    ],
    actorKind: "user",
    actorId: seeded.ownerUserId,
    now: NOW,
  });
  const [proposal] = await db.update(schema.proposals)
    .set({ status: "accepted", decidedAt: NOW, packageId: seeded.packageId })
    .where(eq(schema.proposals.id, detail.proposal.id))
    .returning();
  const [acceptance] = await db.insert(schema.proposalAcceptances).values({
    organisationId: seeded.organisationId,
    proposalId: proposal!.id,
    acceptedName: "Shumaila Khan",
    acceptedEmail: "office@grayscabline.test",
    acceptedAt: NOW,
  }).returning();
  return { ...seeded, proposal: proposal!, acceptanceId: acceptance!.id };
}

/** The session `proposals-accepted.ts` mints, in the shape Stripe sends it back. */
function checkoutEvent(input: {
  organisationId: string;
  proposalId: string;
  acceptanceId: string;
  clientId?: string;
  packageId?: string;
  sessionId?: string;
  subscription?: string | null;
}): PaymentsWebhookEvent {
  return {
    id: `evt_${randomUUID()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: input.sessionId ?? "cs_test_p5",
        status: "complete",
        payment_status: "paid",
        customer: CUSTOMER,
        ...(input.subscription === null ? {} : { subscription: input.subscription ?? SUBSCRIPTION }),
        customer_details: { email: "office@grayscabline.test" },
        metadata: {
          launchos: PROPOSAL_CHECKOUT_MARKER,
          organisationId: input.organisationId,
          proposalId: input.proposalId,
          acceptanceId: input.acceptanceId,
          ...(input.clientId ? { clientId: input.clientId } : {}),
          ...(input.packageId ? { packageId: input.packageId } : {}),
        },
      },
    },
  } as unknown as PaymentsWebhookEvent;
}

describe("checkoutOrganisationFromEvent", () => {
  it("resolves tenancy for a proposal's session as well as a signup's", async () => {
    const organisationId = randomUUID();
    const event = checkoutEvent({ organisationId, proposalId: randomUUID(), acceptanceId: randomUUID() });
    expect(checkoutOrganisationFromEvent(event)).toBe(organisationId);

    // Anything that is not one of ours resolves to nothing, so the route falls
    // back to the customer lookup exactly as it did before.
    const foreign = { ...event, data: { object: { metadata: { launchos: "someone-else", organisationId } } } };
    expect(checkoutOrganisationFromEvent(foreign as unknown as PaymentsWebhookEvent)).toBeNull();
    expect(checkoutOrganisationFromEvent({ ...event, type: "invoice.paid" } as PaymentsWebhookEvent)).toBeNull();
  });
});

describe("completeProposalCheckout", () => {
  it("links the customer, files the subscription under the client and stamps the proposal paid", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId, proposal, acceptanceId } = await acceptedProposal(db);

      const result = await syncFromPaymentsEvent(
        db, organisationId,
        checkoutEvent({ organisationId, proposalId: proposal.id, acceptanceId, clientId, packageId }),
      );

      expect(result).toEqual({ handled: true, action: "proposal.paid" });

      const [account] = await db.select().from(schema.clientPaymentAccounts).where(and(
        eq(schema.clientPaymentAccounts.organisationId, organisationId),
        eq(schema.clientPaymentAccounts.externalCustomerId, CUSTOMER),
      ));
      expect(account!.clientId).toBe(clientId);

      const [subscription] = await db.select().from(schema.subscriptions).where(and(
        eq(schema.subscriptions.organisationId, organisationId),
        eq(schema.subscriptions.stripeSubscriptionId, SUBSCRIPTION),
      ));
      expect(subscription!.clientId).toBe(clientId);
      expect(subscription!.packageId).toBe(packageId);
      expect(subscription!.amountPence).toBe(25_000);

      const [after] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, proposal.id));
      expect(after!.metadata[CHECKOUT_PAID_SESSION_ID]).toBe("cs_test_p5");
    });
  });

  it("is idempotent by session, because Stripe redelivers", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId, proposal, acceptanceId } = await acceptedProposal(db);
      const event = checkoutEvent({ organisationId, proposalId: proposal.id, acceptanceId, clientId, packageId });

      const first = await syncFromPaymentsEvent(db, organisationId, event);
      const second = await syncFromPaymentsEvent(db, organisationId, event);

      expect(first.action).toBe("proposal.paid");
      expect(second).toEqual({ handled: true, action: "proposal.duplicate" });

      const subscriptions = await db.select().from(schema.subscriptions)
        .where(eq(schema.subscriptions.organisationId, organisationId));
      expect(subscriptions).toHaveLength(1);
      const audits = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, organisationId),
        eq(schema.auditLog.action, "proposal.paid"),
      ));
      expect(audits).toHaveLength(1);
    });
  });

  it("records no subscription for a one-off payment", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, proposal, acceptanceId } = await acceptedProposal(db);

      const result = await completeProposalCheckout(db, organisationId, {
        session: {
          id: "cs_one_off",
          status: "complete",
          paymentStatus: "paid",
          customerId: CUSTOMER,
          metadata: {
            launchos: PROPOSAL_CHECKOUT_MARKER,
            organisationId,
            proposalId: proposal.id,
            acceptanceId,
            clientId,
          },
        },
      });

      expect(result.subscriptionId).toBeNull();
      expect(result.clientId).toBe(clientId);
      const subscriptions = await db.select().from(schema.subscriptions)
        .where(eq(schema.subscriptions.organisationId, organisationId));
      expect(subscriptions).toHaveLength(0);
    });
  });

  it("refuses another organisation's session and an unpaid one", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, proposal, acceptanceId } = await acceptedProposal(db);
      const [other] = await db.insert(schema.organisations)
        .values({ name: "Other", slug: `o-${randomUUID()}` }).returning();

      // The organisation is inside the metadata we signed the session with, so
      // a session minted for one tenant cannot be filed against another.
      await expect(completeProposalCheckout(db, other!.id, {
        session: {
          id: "cs_wrong_org", status: "complete", paymentStatus: "paid", customerId: CUSTOMER,
          metadata: { launchos: PROPOSAL_CHECKOUT_MARKER, organisationId, proposalId: proposal.id, acceptanceId, clientId },
        },
      })).rejects.toThrow(ProposalRefused);

      await expect(completeProposalCheckout(db, organisationId, {
        session: {
          id: "cs_unpaid", status: "open", paymentStatus: "unpaid", customerId: CUSTOMER,
          metadata: { launchos: PROPOSAL_CHECKOUT_MARKER, organisationId, proposalId: proposal.id, acceptanceId, clientId },
        },
      })).rejects.toThrow(ProposalRefused);

      const [after] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, proposal.id));
      expect(after!.metadata[CHECKOUT_PAID_SESSION_ID]).toBeUndefined();
    });
  });
});
