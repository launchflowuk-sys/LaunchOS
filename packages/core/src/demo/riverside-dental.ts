import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import {
  counter,
  daysAgo,
  dayOnly,
  DEMO_PREFIX,
  DEMO_PROPOSAL_PREFIX,
  DEMO_REFERENCE_PREFIX,
  type DemoClientResult,
  periodKey,
} from "./shared.js";

/**
 * The delivered client: enquiry, brief, proposal, build, launch, marketing —
 * all of it behind them.
 *
 * This is the "here is the whole journey" record. It is deliberately finished:
 * every phase done, every invoice paid, the site live. What it cannot show is
 * work in progress, which is why `thameside-garage.ts` exists beside it.
 *
 * **Direct inserts, deliberately, not the real `createLead` and friends.**
 * Those are correct for real work and wrong here: `createLead` queues an
 * acknowledgement email and emits `lead.created`, which starts the Lead
 * Qualifier. A demo that emails a made-up address and burns agent tokens is
 * not a demo, it is an incident. Every row here is written flat, with nothing
 * queued, nothing emitted and nothing sent.
 */

const DEMO = {
  business: "Riverside Dental Practice",
  slug: "demo-riverside-dental",
  contact: "Priya Raman",
  email: "priya@riverside-dental.example",
  phone: "01375 555 0142",
  domain: "riverside-dental.example",
} as const;

export async function seedDeliveredDemoClient(
  db: Db,
  organisationId: string,
  now: Date = new Date(),
): Promise<DemoClientResult> {
  const { created, count } = counter();

  // --- 1. The enquiry, from a paid Facebook click -------------------------
  const [lead] = await db
    .insert(schema.leads)
    .values({
      organisationId,
      name: `${DEMO_PREFIX}${DEMO.contact}`,
      email: DEMO.email,
      phone: DEMO.phone,
      business: DEMO.business,
      message: "We need a new website. Patients keep ringing to book because the current site has no online booking, and the receptionist spends half her day on the phone.",
      source: "brief-funnel",
      status: "converted",
      createdAt: daysAgo(84, now),
      qualification: { budget: "3000_7500", timeline: "1_3_months", decisionMaker: true },
      // The attribution the funnel now carries. This is what a paid click
      // looks like once it reaches a lead.
      metadata: {
        attribution: {
          utmSource: "facebook",
          utmMedium: "paid_social",
          utmCampaign: "launchflow_growth",
          utmContent: "creative_a",
          fbclid: "IwAR-demo-click",
          landingPath: "/start",
        },
      },
    })
    .returning();
  count("leads");

  // --- 2. The brief they filled in, and the written version ---------------
  const reference = `${DEMO_REFERENCE_PREFIX}0001`;
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
      source: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "launchflow_growth", entry_route: "/start" },
      expiresAt: daysAgo(-30, now),
      createdAt: daysAgo(84, now),
      answers: {
        name: DEMO.contact,
        email: DEMO.email,
        phone: DEMO.phone,
        business: DEMO.business,
        whatYouDo: "NHS and private dentistry in Grays, seven surgeries, twenty-two staff.",
        problem: "No online booking. Reception takes 60+ calls a day, most of them appointments.",
        wantFromSite: "Online booking, treatment prices, new-patient registration, and a way to remind people about check-ups.",
        audience: "Local families and private patients within about ten miles.",
        budget: "£3,000–£7,500",
        timeline: "Within three months",
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
      sourceRevision: 14,
      questionnaireVersion: 1,
      idempotencyKey: randomUUID(),
      reference,
      createdAt: daysAgo(84, now),
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
    createdAt: daysAgo(84, now),
    markdown: [
      `# ${DEMO.business} — website and booking`,
      "",
      "## The business",
      "A seven-surgery NHS and private dental practice in Grays, Essex, with twenty-two staff. Established, busy, and losing reception time to a phone that never stops.",
      "",
      "## The problem worth solving",
      "Reception handles more than sixty calls a day and most are appointment bookings that could happen without a person. The current site is a brochure: it lists services and a phone number and does nothing else. Every booking therefore costs staff time, and calls outside opening hours are simply lost.",
      "",
      "## What the build needs to do",
      "- Online booking that writes into the practice diary, not a form that emails reception",
      "- Treatment prices, published and easy to keep current",
      "- New-patient registration completed before the first visit",
      "- Recall reminders for check-ups",
      "",
      "## Scope",
      "A new website with a connected booking system and a back office for reception. Payments are out of scope for phase one — NHS charges are taken at the desk, and private treatment is quoted per plan.",
      "",
      "## Worth raising with them",
      "Their diary software is the constraint. If it has no API the booking has to live in LaunchOS and be reconciled, which is a different shape of job and a different price. Ask before quoting.",
    ].join("\n"),
    structured: {
      projectTitle: `${DEMO.business} — website and booking`,
      businessSummary: "Seven-surgery NHS and private dental practice in Grays, Essex. Twenty-two staff.",
      goals: ["Take bookings without reception", "Publish prices", "Register new patients before arrival", "Automate check-up recalls"],
      outOfScope: ["Online payment for NHS charges"],
      risks: ["The practice diary software may have no API, which changes the shape and price of the booking work"],
    },
  });
  count("briefVersions");

  // --- 3. The proposal ----------------------------------------------------
  const [proposal] = await db
    .insert(schema.proposals)
    .values({
      organisationId,
      leadId: lead!.id,
      reference: `${DEMO_PROPOSAL_PREFIX}01`,
      title: `${DEMO_PREFIX}Website and booking system`,
      summary: "A new website with online booking, prices, new-patient registration and recall reminders.",
      status: "accepted",
      publicToken: randomUUID().replace(/-/g, ""),
      sentAt: daysAgo(77, now),
      firstViewedAt: daysAgo(76, now),
      decidedAt: daysAgo(74, now),
      createdAt: daysAgo(78, now),
      scope: {
        deliverables: [
          "Eight-page website",
          "Online booking connected to the practice diary",
          "Published treatment prices",
          "New-patient registration form",
          "Check-up recall reminders",
          "Reception back office",
        ],
        outOfScope: ["Card payment for NHS charges", "Migration of historic patient records"],
        timeline: "Eight weeks from sign-off, in two stages.",
      },
      // The three amounts are derived from the proposal's lines in real use.
      // Written directly here because a demo has no lines to derive them from.
      pricing: {
        shape: "setup_plus_monthly",
        setupPence: 545_000,
        monthlyPence: 19_900,
        oneOffPence: 0,
        currency: "GBP",
        vatNote: "No VAT — LaunchFlow UK Limited is not VAT registered.",
      },
      terms: "50% on acceptance, 50% on launch. Care plan monthly, cancel with 30 days' notice.",
      validUntil: dayOnly(60, now),
    })
    .returning();
  count("proposals");

  // --- 4. The client -----------------------------------------------------
  const [client] = await db
    .insert(schema.clients)
    .values({
      organisationId,
      name: `${DEMO_PREFIX}${DEMO.business}`,
      slug: DEMO.slug,
      tradingName: DEMO.business,
      email: DEMO.email,
      phone: DEMO.phone,
      city: "Grays",
      postcode: "RM17 6ES",
      country: "GB",
      industry: "Dentistry",
      websiteUrl: `https://${DEMO.domain}`,
      status: "active",
      onboardedAt: daysAgo(74, now),
      handoverAt: daysAgo(21, now),
      createdAt: daysAgo(74, now),
      notes: "Demonstration client. Not real, not billed, safe to delete.",
    })
    .returning();
  count("clients");

  await db.update(schema.leads).set({ clientId: client!.id }).where(eq(schema.leads.id, lead!.id)).catch(() => undefined);
  await db.update(schema.proposals).set({ clientId: client!.id }).where(eq(schema.proposals.id, proposal!.id));

  // --- 5. The build -------------------------------------------------------
  const [project] = await db
    .insert(schema.projects)
    .values({
      organisationId,
      clientId: client!.id,
      proposalId: proposal!.id,
      name: `${DEMO_PREFIX}Website and booking build`,
      summary: "New website, online booking, reception back office.",
      status: "delivered",
      startedAt: daysAgo(72, now),
      targetDate: dayOnly(24, now),
      deliveredAt: daysAgo(21, now),
      createdAt: daysAgo(74, now),
    })
    .returning();
  count("projects");

  // The keys are a fixed vocabulary — `brief`, `design`, `build`, `review`,
  // `launch`, `care` — so the phase names here follow the schema rather than
  // whatever a project plan happens to call its stages.
  const phases = [
    { key: "brief", name: "Brief and discovery", days: 70 },
    { key: "design", name: "Design", days: 62 },
    { key: "build", name: "Build", days: 48 },
    { key: "review", name: "Content and review", days: 32 },
    { key: "launch", name: "Launch", days: 21 },
    { key: "care", name: "Care plan", days: 20 },
  ] as const;
  for (const [index, phase] of phases.entries()) {
    await db.insert(schema.projectPhases).values({
      organisationId,
      projectId: project!.id,
      clientId: client!.id,
      key: phase.key,
      name: phase.name,
      status: "done",
      sort: index + 1,
      startedAt: daysAgo(phase.days + 6, now),
      doneAt: daysAgo(phase.days, now),
    });
    count("projectPhases");
  }

  const milestones = [
    { title: "Design signed off", days: 60, visible: true },
    { title: "Booking connected to the practice diary", days: 44, visible: true },
    { title: "Content loaded and proofed", days: 30, visible: true },
    { title: "Site live", days: 21, visible: true },
    { title: "DNS moved, old host cancelled", days: 20, visible: false },
  ] as const;
  for (const [index, milestone] of milestones.entries()) {
    await db.insert(schema.projectMilestones).values({
      organisationId,
      projectId: project!.id,
      clientId: client!.id,
      title: milestone.title,
      clientVisible: milestone.visible,
      sort: index + 1,
      reachedAt: daysAgo(milestone.days, now),
    });
    count("projectMilestones");
  }

  // --- 6. The live site and domain ---------------------------------------
  const [site] = await db
    .insert(schema.sites)
    .values({
      organisationId,
      clientId: client!.id,
      name: `${DEMO.business} website`,
      primaryUrl: `https://${DEMO.domain}`,
      status: "live",
      platform: "nextjs",
      createdAt: daysAgo(48, now),
    })
    .returning();
  count("sites");

  await db.insert(schema.domains).values({
    organisationId,
    clientId: client!.id,
    name: DEMO.domain,
    registrar: "hostinger",
    registeredAt: daysAgo(50, now),
    expiresAt: daysAgo(-315, now),
    autoRenew: true,
  });
  count("domains");

  // --- 7. The money -------------------------------------------------------
  await db.insert(schema.subscriptions).values({
    organisationId,
    clientId: client!.id,
    status: "active",
    amountPence: 19_900,
    currentPeriodStart: daysAgo(9, now),
    currentPeriodEnd: daysAgo(-21, now),
    createdAt: daysAgo(21, now),
  });
  count("subscriptions");

  // No VAT on any of these. LaunchFlow UK Limited is not VAT registered, so a
  // demo invoice showing 20% is a demo of something that cannot happen — and
  // it is the kind of detail a prospect notices on a screenshare.
  // `vatRateForOrganisation` returns 0 without a registration number, which is
  // what a real invoice would carry.
  for (const invoice of [
    { number: "DEMO-0001", days: 74, subtotal: 272_500, note: "Build, first half" },
    { number: "DEMO-0002", days: 21, subtotal: 272_500, note: "Build, second half" },
    { number: "DEMO-0003", days: 9, subtotal: 19_900, note: "Care plan" },
  ]) {
    const vat = 0;
    await db.insert(schema.invoices).values({
      organisationId,
      clientId: client!.id,
      number: invoice.number,
      status: "paid",
      issuedAt: daysAgo(invoice.days, now),
      dueAt: daysAgo(invoice.days - 14, now),
      paidAt: daysAgo(invoice.days - 3, now),
      subtotalPence: invoice.subtotal,
      vatPence: vat,
      totalPence: invoice.subtotal + vat,
      lineItems: [{ description: invoice.note, quantity: 1, unitPence: invoice.subtotal }],
    });
    count("invoices");
  }

  // --- 8. The marketing that follows the launch ---------------------------
  await db.insert(schema.contentBriefs).values({
    organisationId,
    clientId: client!.id,
    tone: "Warm, plain, never salesy. Patients are often nervous — reassurance before persuasion.",
    audience: "Local families and private patients within ten miles of Grays.",
    services: "NHS and private dentistry, hygienist, whitening, Invisalign, emergency appointments.",
    offers: "Free children's check-ups on the NHS. New-patient examination at £39.",
    area: "Grays, Tilbury, Chafford Hundred, South Ockendon and the rest of Thurrock.",
    doNotSay: "No before-and-after photos without written consent. Nothing that reads as a medical claim or a guarantee of outcome. No discount or urgency language — it reads badly for a dental practice.",
    notes: "Nervous patients are a large part of the audience. Reassurance before persuasion, every time.",
  });
  count("contentBriefs");

  await db.insert(schema.contentChannels).values({
    organisationId,
    clientId: client!.id,
    channel: "facebook",
    externalId: "000000000000000",
    displayName: `${DEMO.business} (demo)`,
    // Off on purpose. A demo channel that is enabled is a demo the publisher
    // would try to post to, against a Page id that does not exist.
    enabled: false,
  });
  count("contentChannels");

  const period = periodKey(now);
  const posts = [
    { channel: "blog" as const, kind: "blog_post" as const, status: "published" as const, days: 14, title: "What happens at your first visit", body: "Nobody enjoys a first appointment at a new practice. Here is exactly what happens, in order, so there are no surprises." },
    { channel: "facebook" as const, kind: "social_post" as const, status: "published" as const, days: 11, title: null, body: "Booking a check-up now takes about thirty seconds online — no phone queue, no waiting for reception to pick up. Link in bio." },
    { channel: "facebook" as const, kind: "social_post" as const, status: "published" as const, days: 6, title: null, body: "Nervous about the dentist? Tell us when you book and we will give you a longer appointment and go at your pace." },
    { channel: "blog" as const, kind: "blog_post" as const, status: "approved" as const, days: -3, title: "Our treatment prices, explained", body: "Private dentistry pricing is usually opaque. Here is what each treatment costs and why." },
    { channel: "facebook" as const, kind: "social_post" as const, status: "awaiting_approval" as const, days: -5, title: null, body: "Children's check-ups are free on the NHS. If your child has not been seen in a while, we have space this month." },
  ];
  for (const post of posts) {
    await db.insert(schema.contentItems).values({
      organisationId,
      clientId: client!.id,
      channel: post.channel,
      kind: post.kind,
      status: post.status,
      periodKey: period,
      title: post.title,
      body: post.body,
      source: "agent",
      scheduledFor: daysAgo(post.days, now),
      ...(post.status === "published"
        ? { publishedAt: daysAgo(post.days, now), externalUrl: `https://${DEMO.domain}/news` }
        : {}),
    });
    count("contentItems");
  }

  return { clientId: client!.id, leadId: lead!.id, projectId: project!.id, reference, created };
}
