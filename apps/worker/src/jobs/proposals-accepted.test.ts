import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  PROPOSAL_SIGNED_DOCUMENT_KIND,
  acceptProposal,
  createLead,
  createProposal,
  getProposalAcceptance,
  getProposalDetail,
  sendProposal,
  setEnqueue,
  setProposalFollowOn,
  type ProposalLineInput,
} from "@launchos/core";
import type { ProposalPricingShape } from "@launchos/db/schema";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { handleProposalAccepted, paymentStepFor } from "./proposals-accepted.js";
import { followOnJobFor } from "./proposals-send.js";

setEnqueue(async () => {});
setProposalFollowOn(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-follow-on-"));
const ENV = {
  STORAGE_DIR: storage,
  APP_URL: "https://os.launchflow.test",
  // The lead conversion inside `acceptProposal` writes a billing profile, and
  // that is encrypted at rest.
  SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
} as NodeJS.ProcessEnv;
const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-09-07T10:00:00Z");

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

interface Options {
  shape: ProposalPricingShape;
  lines: ProposalLineInput[];
  stripePriceId?: string | null;
}

async function accepted(db: Db, options: Options) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `fo-${randomUUID()}` }).returning();
  const organisationId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId, userId: ownerId, role: "owner", status: "active" });
  const [pkg] = await db.insert(schema.packages).values({
    organisationId, name: "Care", slug: "care", monthlyPricePence: 9_900,
    stripePriceId: options.stripePriceId === undefined ? "price_care" : options.stripePriceId,
  }).returning();
  const lead = await createLead(db, organisationId, {
    name: "Aisha Khan", business: "Khan Dental", email: "aisha@khandental.test", source: "website",
    notifyOwner: false, acknowledge: false,
  }, ENV);

  const drafted = await createProposal(db, organisationId, {
    leadId: lead.id,
    title: "Website and care for Khan Dental",
    scope: { deliverables: ["Six-page website", "Hosting and backups"], outOfScope: [], timeline: "Four working weeks." },
    pricing: { shape: options.shape, packageId: pkg!.id },
    lines: options.lines,
    actorId: ownerId,
    now: NOW,
  });
  await sendProposal(db, organisationId, { proposalId: drafted.proposal.id, actorKind: "user", actorId: ownerId, now: NOW }, undefined, ENV);
  const sent = (await getProposalDetail(db, organisationId, drafted.proposal.id))!;
  await acceptProposal(db, organisationId, {
    token: sent.proposal.publicToken, acceptedName: "Aisha Khan", acceptedEmail: "aisha@khandental.test",
    signatureSvg: "M 10 10 L 200 120", now: NOW,
  }, ENV);
  const job = (await followOnJobFor(db, organisationId, drafted.proposal.id))!;
  return { organisationId, ownerId, proposalId: drafted.proposal.id, packageId: pkg!.id, job };
}

const SETUP_PLUS_MONTHLY: ProposalLineInput[] = [
  { kind: "setup", description: "Design and build", unitPence: 120_000 },
  { kind: "monthly", description: "Care plan", unitPence: 9_900 },
];

async function paymentNotice(db: Db, organisationId: string) {
  const rows = await db.select().from(schema.messages).where(eq(schema.messages.organisationId, organisationId));
  return rows.find((m) => m.metadata["notice"] === "payment") ?? null;
}

describe("paymentStepFor", () => {
  it("opens one Checkout carrying the setup fee and the retainer together", () => {
    expect(paymentStepFor({ dueOnAcceptancePence: 120_000, recurringMonthlyPence: 9_900, packagePriceId: "price_care" }))
      .toEqual({ kind: "checkout", priceId: "price_care", dueOnAcceptancePence: 120_000, recurringMonthlyPence: 9_900, reason: null });
  });

  it("opens a payment-mode Checkout for a one-off, and nothing at all when the first month is owed on delivery", () => {
    expect(paymentStepFor({ dueOnAcceptancePence: 95_000, recurringMonthlyPence: 0, packagePriceId: null }))
      .toMatchObject({ kind: "checkout", priceId: null, dueOnAcceptancePence: 95_000 });
    // Nothing due today is `monthly_on_delivery`, and it opens no Checkout —
    // a subscription session would take the first month on the spot.
    expect(paymentStepFor({ dueOnAcceptancePence: 0, recurringMonthlyPence: 25_000, packagePriceId: "price_care" }).kind)
      .toBe("none");
    expect(paymentStepFor({ dueOnAcceptancePence: 0, recurringMonthlyPence: 0, packagePriceId: null }).kind).toBe("none");
  });

  it("refuses to improvise a subscription with no Stripe price, and says why", () => {
    const step = paymentStepFor({ dueOnAcceptancePence: 120_000, recurringMonthlyPence: 9_900, packagePriceId: null });
    expect(step.kind).toBe("manual");
    expect(step.reason).toMatch(/setup fee and the retainer/i);
  });
});

describe("proposals.accepted", () => {
  it("countersigns, opens one Checkout with both lines on it, writes the work and emails the link", async () => {
    await withTestDb(async (db) => {
      const f = await accepted(db, { shape: "setup_plus_monthly", lines: SETUP_PLUS_MONTHLY });
      const payments = new MockPaymentsAdapter();
      const result = await handleProposalAccepted({ db, payments, env: ENV, logger: quiet }, f.job);

      expect(result).toMatchObject({ countersigned: true, payment: "checkout", tasksCreated: 2 });

      // The signed copy is filed against the acceptance, not just rendered.
      const acceptance = (await getProposalAcceptance(db, f.organisationId, f.proposalId))!;
      expect(acceptance.documentId).not.toBeNull();
      const [signed] = await db.select().from(schema.documents)
        .where(and(eq(schema.documents.id, acceptance.documentId!), eq(schema.documents.organisationId, f.organisationId)));
      expect(signed!.kind).toBe(PROPOSAL_SIGNED_DOCUMENT_KIND);

      // One session, in subscription mode, carrying the retainer's price *and*
      // the setup fee — not two sessions and not a dropped setup fee.
      const session = await payments.retrieveCheckoutSession(
        (await getProposalDetail(db, f.organisationId, f.proposalId))!.proposal.metadata["checkoutSessionId"] as string,
      );
      expect(session.metadata).toMatchObject({
        launchos: "proposal", proposalId: f.proposalId, priceId: "price_care",
        mode: "subscription", oneOffPence: "120000",
      });

      const notice = await paymentNotice(db, f.organisationId);
      expect(notice?.toEmail).toBe("aisha@khandental.test");
      expect(notice?.body).toContain("£1,200.00");
      expect(notice?.body).toContain("£99.00 a month");

      const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.organisationId, f.organisationId));
      expect(tasks.map((t) => t.title).sort()).toEqual(["Hosting and backups", "Six-page website"]);
    });
  });

  it("runs twice without countersigning twice, charging twice or duplicating the work", async () => {
    await withTestDb(async (db) => {
      const f = await accepted(db, { shape: "setup_plus_monthly", lines: SETUP_PLUS_MONTHLY });
      const payments = new MockPaymentsAdapter();
      await handleProposalAccepted({ db, payments, env: ENV, logger: quiet }, f.job);
      const again = await handleProposalAccepted({ db, payments, env: ENV, logger: quiet }, f.job);

      expect(again).toMatchObject({ countersigned: false, payment: "already", tasksCreated: 0 });
      const signedCopies = await db.select().from(schema.documents).where(and(
        eq(schema.documents.organisationId, f.organisationId),
        eq(schema.documents.kind, PROPOSAL_SIGNED_DOCUMENT_KIND),
      ));
      expect(signedCopies).toHaveLength(1);
      const payLinks = (await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.organisationId)))
        .filter((m) => m.metadata["notice"] === "payment");
      expect(payLinks).toHaveLength(1);
      expect(await db.select().from(schema.tasks).where(eq(schema.tasks.organisationId, f.organisationId))).toHaveLength(2);
    });
  });

  it("takes a one-off in payment mode with no subscription price at all", async () => {
    await withTestDb(async (db) => {
      const f = await accepted(db, {
        shape: "one_off",
        lines: [{ kind: "one_off", description: "Rebuild", unitPence: 95_000 }],
        stripePriceId: null,
      });
      const payments = new MockPaymentsAdapter();
      const result = await handleProposalAccepted({ db, payments, env: ENV, logger: quiet }, f.job);
      expect(result.payment).toBe("checkout");
      const detail = (await getProposalDetail(db, f.organisationId, f.proposalId))!;
      const session = await payments.retrieveCheckoutSession(detail.proposal.metadata["checkoutSessionId"] as string);
      expect(session.metadata["mode"]).toBe("payment");
      expect(session.metadata["priceId"]).toBeUndefined();
      expect(session.metadata["oneOffPence"]).toBe("95000");
    });
  });

  it("takes nothing today for a monthly-on-delivery proposal, and tells Shoji why", async () => {
    await withTestDb(async (db) => {
      const f = await accepted(db, { shape: "monthly_on_delivery", lines: [{ kind: "monthly", description: "Care plan", unitPence: 9_900 }] });
      const result = await handleProposalAccepted({ db, payments: new MockPaymentsAdapter(), env: ENV, logger: quiet }, f.job);

      // No session, and no payment link claiming money the proposal said was
      // not due — the acceptance email already promised nothing to pay today.
      expect(result).toMatchObject({ payment: "none", checkoutUrl: null });
      const detail = (await getProposalDetail(db, f.organisationId, f.proposalId))!;
      expect(detail.proposal.metadata["checkoutSessionId"]).toBeUndefined();
      expect(await paymentNotice(db, f.organisationId)).toBeNull();

      const bells = await db.select().from(schema.notifications).where(and(
        eq(schema.notifications.organisationId, f.organisationId),
        eq(schema.notifications.kind, "proposal.payment_step"),
      ));
      expect(bells[0]!.body).toMatch(/when the work goes live/i);
      // The work is still opened, because that is what they agreed to.
      expect(result.tasksCreated).toBe(2);
    });
  });

  it("asks Shoji to raise the retainer by hand rather than dropping a monthly fee Stripe cannot bill", async () => {
    await withTestDb(async (db) => {
      const f = await accepted(db, { shape: "setup_plus_monthly", lines: SETUP_PLUS_MONTHLY, stripePriceId: null });
      const result = await handleProposalAccepted({ db, payments: new MockPaymentsAdapter(), env: ENV, logger: quiet }, f.job);
      expect(result).toMatchObject({ payment: "manual", checkoutUrl: null });
      const bells = await db.select().from(schema.notifications).where(and(
        eq(schema.notifications.organisationId, f.organisationId),
        eq(schema.notifications.kind, "proposal.payment_step"),
      ));
      expect(bells).toHaveLength(1);
      expect(bells[0]!.body).toMatch(/by hand/i);
      // No payment link went out claiming money we cannot take.
      expect(await paymentNotice(db, f.organisationId)).toBeNull();
    });
  });
});
