import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import {
  counter,
  daysAgo,
  dayOnly,
  DEMO_PREFIX,
  DEMO_PROPOSAL_PREFIX,
  demoReference,
} from "./shared.js";

/**
 * The enquiry still being decided: brief in, proposal sent, proposal read,
 * no answer yet.
 *
 * Neither client record can show this, because both of them said yes. The top
 * of the funnel — a lead that is qualified but not converted, and a proposal
 * sitting at `viewed` with its `valid_until` still in the future — is the
 * state the Leads and Proposals screens spend most of their time in, and
 * without it both look like archives.
 *
 * **No client row, deliberately.** A client is created when a proposal is
 * accepted. Seeding one here to make the record look complete would put a
 * client on the list who has not bought anything, which is the opposite of
 * what the screen is for. `proposals` allows this: its check constraint wants
 * a lead *or* a client, not both.
 *
 * Nothing queued, nothing emitted, nothing sent — as with the other two.
 */

const DEMO = {
  business: "Lumen Hair Studio",
  contact: "Nadia Okonkwo",
  email: "nadia@lumen-hair.example",
  phone: "01375 555 0231",
} as const;

export interface DemoLeadResult {
  leadId: string;
  proposalId: string;
  reference: string;
  created: Record<string, number>;
}

export async function seedOpenDemoLead(
  db: Db,
  organisationId: string,
  now: Date = new Date(),
): Promise<DemoLeadResult> {
  const { created, count } = counter();

  // Qualified, not converted. The Lead Qualifier has scored it and nobody has
  // signed anything.
  const [lead] = await db
    .insert(schema.leads)
    .values({
      organisationId,
      name: `${DEMO_PREFIX}${DEMO.contact}`,
      email: DEMO.email,
      phone: DEMO.phone,
      business: DEMO.business,
      message:
        "Opening a second chair in October and the Instagram is doing all the work at the moment. I need an actual website with online booking before then.",
      source: "brief-funnel",
      status: "qualified",
      createdAt: daysAgo(8, now),
      qualification: { budget: "1500_3000", timeline: "1_3_months", decisionMaker: true },
      metadata: {
        attribution: {
          utmSource: "instagram",
          utmMedium: "paid_social",
          utmCampaign: "launchflow_growth",
          utmContent: "creative_b",
          fbclid: "IwAR-demo-click-2",
          landingPath: "/start",
        },
      },
    })
    .returning();
  count("leads");

  const reference = demoReference(organisationId, 3);
  const [session] = await db
    .insert(schema.briefSessions)
    .values({
      organisationId,
      sessionSecretHash: randomUUID().replace(/-/g, ""),
      questionnaireVersion: 1,
      status: "submitted",
      currentStep: 8,
      completedSteps: [1, 2, 3, 4, 5, 6, 7, 8],
      leadId: lead!.id,
      source: {
        utm_source: "instagram",
        utm_medium: "paid_social",
        utm_campaign: "launchflow_growth",
        entry_route: "/start",
      },
      expiresAt: daysAgo(-30, now),
      createdAt: daysAgo(8, now),
      answers: {
        name: DEMO.contact,
        email: DEMO.email,
        phone: DEMO.phone,
        business: DEMO.business,
        whatYouDo: "Hair salon in Grays. Cuts, colour and treatments. Two of us from October.",
        problem: "Everything runs through Instagram DMs. I lose bookings overnight and I cannot see my own week properly.",
        wantFromSite: "Online booking, a price list, and somewhere to put the photos that is mine rather than Instagram's.",
        audience: "Women 25–55 in Grays and Chafford Hundred, mostly word of mouth.",
        budget: "£1,500–£3,000",
        timeline: "Before October",
      },
    })
    .returning();
  count("briefSessions");

  const [submission] = await db
    .insert(schema.briefSubmissions)
    .values({
      organisationId,
      sessionId: session!.id,
      answers: session!.answers,
      sourceRevision: 9,
      questionnaireVersion: 1,
      idempotencyKey: randomUUID(),
      reference,
      createdAt: daysAgo(8, now),
    })
    .returning();
  count("briefSubmissions");

  await db.insert(schema.briefVersions).values({
    organisationId,
    submissionId: submission!.id,
    version: 1,
    generatorVersion: "brief-writer-demo",
    model: "gpt-6-astra",
    schemaVersion: "1",
    createdAt: daysAgo(8, now),
    markdown: [
      `# ${DEMO.business} — website and online booking`,
      "",
      "## The business",
      "A one-chair hair salon in Grays becoming a two-chair salon in October. Fully booked on word of mouth and Instagram, with no website at all.",
      "",
      "## The problem worth solving",
      "Every booking arrives as an Instagram DM, which means bookings are lost overnight, the diary lives in her head, and the second chair cannot be filled by anyone but her. The constraint is not marketing — she has more demand than hours. It is that nothing is written down.",
      "",
      "## What the build needs to do",
      "- Online booking, per stylist, against real availability",
      "- A price list she can change herself",
      "- A gallery she owns, rather than a feed she rents",
      "",
      "## Scope",
      "A small site — four pages — with booking as the whole point of it. Deposits at booking are worth discussing; no-shows are the thing that actually costs her money.",
      "",
      "## Worth raising with them",
      "October is a hard date, not a preference: the second chair is already hired. Quote against that, and say plainly what has to be decided by when.",
    ].join("\n"),
    structured: {
      projectTitle: `${DEMO.business} — website and online booking`,
      businessSummary: "One-chair hair salon in Grays, Essex, expanding to two chairs in October.",
      goals: ["Take bookings off Instagram DMs", "Per-stylist availability", "Own the gallery"],
      outOfScope: ["Retail product sales"],
      risks: ["October is a hired-staff deadline, not a preference", "No-shows may need deposits at booking, which changes the build"],
    },
  });
  count("briefVersions");

  // Sent, read, and no decision. `decidedAt` stays null and `validUntil` is
  // nine days in the future, which is what puts it on the live-proposals list
  // rather than the expired one.
  const [proposal] = await db
    .insert(schema.proposals)
    .values({
      organisationId,
      leadId: lead!.id,
      reference: `${DEMO_PROPOSAL_PREFIX}03`,
      title: `${DEMO_PREFIX}Website and online booking`,
      summary: "A four-page site built around per-stylist online booking, ready before October.",
      status: "viewed",
      publicToken: randomUUID().replace(/-/g, ""),
      sentAt: daysAgo(5, now),
      firstViewedAt: daysAgo(4, now),
      decidedAt: null,
      createdAt: daysAgo(6, now),
      scope: {
        deliverables: [
          "Four-page website",
          "Online booking, per stylist",
          "Price list she can edit",
          "Photo gallery",
        ],
        outOfScope: ["Retail product sales", "Card deposits at booking — quoted separately once decided"],
        timeline: "Five weeks from sign-off, which lands before October if signed this month.",
      },
      pricing: {
        shape: "monthly_on_delivery",
        setupPence: 0,
        monthlyPence: 17_900,
        oneOffPence: 0,
        currency: "GBP",
        vatNote: "No VAT — LaunchFlow UK Limited is not VAT registered.",
      },
      terms: "Nothing to pay up front. The monthly starts the day the site goes live. Cancel with 30 days' notice.",
      validUntil: dayOnly(-9, now),
    })
    .returning();
  count("proposals");

  return { leadId: lead!.id, proposalId: proposal!.id, reference, created };
}
