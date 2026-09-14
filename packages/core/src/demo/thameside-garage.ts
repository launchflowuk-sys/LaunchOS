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
 * The client who is mid-build — five weeks into an eight-week job.
 *
 * This record exists because the delivered one cannot show the software
 * working. Riverside Dental is finished: every phase done, every invoice paid,
 * nothing waiting on anybody. Screenshare it and the progress spine is a row
 * of ticks, the approvals queue is empty and the money screen is all green —
 * a picture of a *past* job rather than of a system running one.
 *
 * So everything here is deliberately unfinished, and each unfinished thing is
 * a screen that otherwise has nothing on it:
 *
 * | State | What it puts on screen |
 * | --- | --- |
 * | Two phases done, one active, three pending | a progress spine part-way along |
 * | Two milestones reached, four not | a client progress page with work ahead |
 * | Site `building`, not `live` | the build pipeline mid-flight |
 * | One invoice paid, one **overdue** | the money screen with something owed |
 * | Three content items awaiting approval | an approvals queue with a queue in it |
 * | An Instagram channel row | where a client's Instagram appears once connected |
 *
 * A trade rather than a professional practice, and priced like one: a £3,500
 * build with a £149 care plan is the job LaunchFlow actually sells most of.
 * The overdue invoice is an approved extra rather than a stage payment,
 * because the terms say half on acceptance and half on launch — an invoice
 * that contradicts the terms shown beside it is the detail a prospect spots.
 *
 * Direct inserts, for the same reason as the delivered client: nothing queued,
 * nothing emitted, nothing sent.
 */

const DEMO = {
  business: "Thameside Garage",
  slug: "demo-thameside-garage",
  contact: "Dean Wallace",
  email: "dean@thameside-garage.example",
  phone: "01375 555 0198",
  domain: "thameside-garage.example",
} as const;

export async function seedInFlightDemoClient(
  db: Db,
  organisationId: string,
  now: Date = new Date(),
): Promise<DemoClientResult> {
  const { created, count } = counter();

  // --- 1. The enquiry — a paid Google click, so the two demo clients between
  // them show both ad channels rather than two of the same ------------------
  const [lead] = await db
    .insert(schema.leads)
    .values({
      organisationId,
      name: `${DEMO_PREFIX}${DEMO.contact}`,
      email: DEMO.email,
      phone: DEMO.phone,
      business: DEMO.business,
      message:
        "Need a proper website. We come up on Google Maps but the site is from 2014 and you cannot book an MOT on it. Losing work to the chains.",
      source: "brief-funnel",
      status: "converted",
      createdAt: daysAgo(40, now),
      qualification: { budget: "1500_3000", timeline: "asap", decisionMaker: true },
      metadata: {
        attribution: {
          utmSource: "google",
          utmMedium: "cpc",
          utmCampaign: "launchflow_search_brand",
          utmTerm: "website designer grays",
          gclid: "Cj0KCQ-demo-click",
          landingPath: "/start",
        },
      },
    })
    .returning();
  count("leads");

  // --- 2. The brief -------------------------------------------------------
  const reference = `${DEMO_REFERENCE_PREFIX}0002`;
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
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "launchflow_search_brand",
        entry_route: "/start",
      },
      expiresAt: daysAgo(-30, now),
      createdAt: daysAgo(40, now),
      answers: {
        name: DEMO.contact,
        email: DEMO.email,
        phone: DEMO.phone,
        business: DEMO.business,
        whatYouDo: "MOT, servicing and repairs. Four ramps, six staff, on the same site since 1998.",
        problem: "Site is ten years old and does nothing. People ring to book an MOT and if we are under a car nobody picks up.",
        wantFromSite: "Online MOT booking, prices up front, MOT reminders by text, and to stop looking older than the chains.",
        audience: "Drivers within about eight miles. Mostly repeat customers and their families.",
        budget: "£1,500–£3,000",
        timeline: "As soon as possible",
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
      sourceRevision: 11,
      questionnaireVersion: 1,
      idempotencyKey: randomUUID(),
      reference,
      createdAt: daysAgo(40, now),
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
    createdAt: daysAgo(40, now),
    markdown: [
      `# ${DEMO.business} — website and MOT booking`,
      "",
      "## The business",
      "An independent MOT and servicing garage in Grays, four ramps and six staff, on the same site since 1998. Established, well regarded locally, and invisible online next to the national chains.",
      "",
      "## The problem worth solving",
      "The phone is the only way to book, and the phone is answered by whoever is not under a car. Bookings are therefore lost at exactly the times the garage is busiest. The current site was built in 2014, is not readable on a phone, and publishes no prices — so a driver comparing them against a chain has nothing to compare.",
      "",
      "## What the build needs to do",
      "- Online MOT and service booking against real slot availability",
      "- Prices published for MOT, interim and full service",
      "- MOT reminders by text, a month before expiry",
      "- Readable on a phone, because that is where the comparison happens",
      "",
      "## Scope",
      "A five-page site with a booking system and a simple diary the front desk can work from. Parts ordering and invoicing stay in their existing garage software.",
      "",
      "## Worth raising with them",
      "MOT reminders need the DVLA MOT History API, which is free but needs registration and takes a fortnight. Start that application on day one or it becomes the thing that holds up launch.",
    ].join("\n"),
    structured: {
      projectTitle: `${DEMO.business} — website and MOT booking`,
      businessSummary: "Independent MOT and servicing garage in Grays, Essex. Four ramps, six staff, trading since 1998.",
      goals: [
        "Take MOT bookings without the phone",
        "Publish prices",
        "Send MOT reminders by text",
        "Stop looking older than the chains",
      ],
      outOfScope: ["Parts ordering", "Replacing their garage management software"],
      risks: ["DVLA MOT History API registration takes around a fortnight and gates the reminder feature"],
    },
  });
  count("briefVersions");

  // --- 3. The proposal, accepted -----------------------------------------
  const [proposal] = await db
    .insert(schema.proposals)
    .values({
      organisationId,
      leadId: lead!.id,
      reference: `${DEMO_PROPOSAL_PREFIX}02`,
      title: `${DEMO_PREFIX}Website and MOT booking`,
      summary: "A five-page site with online MOT booking, published prices and text reminders.",
      status: "accepted",
      publicToken: randomUUID().replace(/-/g, ""),
      sentAt: daysAgo(36, now),
      firstViewedAt: daysAgo(35, now),
      decidedAt: daysAgo(33, now),
      createdAt: daysAgo(37, now),
      scope: {
        deliverables: [
          "Five-page website",
          "Online MOT and service booking",
          "Published prices",
          "MOT reminders by text",
          "Front-desk diary",
        ],
        outOfScope: ["Parts ordering", "Changes to their garage management software"],
        timeline: "Eight weeks from sign-off.",
      },
      pricing: {
        shape: "setup_plus_monthly",
        setupPence: 350_000,
        monthlyPence: 14_900,
        oneOffPence: 0,
        currency: "GBP",
        vatNote: "No VAT — LaunchFlow UK Limited is not VAT registered.",
      },
      terms: "50% on acceptance, 50% on launch. Care plan monthly from launch, cancel with 30 days' notice.",
      validUntil: dayOnly(7, now),
    })
    .returning();
  count("proposals");

  // --- 4. The client — onboarded, not handed over -------------------------
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
      postcode: "RM17 6BT",
      country: "GB",
      industry: "Motor trade",
      websiteUrl: `https://${DEMO.domain}`,
      status: "active",
      onboardedAt: daysAgo(33, now),
      // Null on purpose: nothing has been handed over, because nothing has
      // launched. A handover date on a live build is the sort of wrong figure
      // that makes every other figure on the screen suspect.
      handoverAt: null,
      createdAt: daysAgo(33, now),
      notes: "Demonstration client, mid-build. Not real, not billed, safe to delete.",
    })
    .returning();
  count("clients");

  await db.update(schema.leads).set({ clientId: client!.id }).where(eq(schema.leads.id, lead!.id)).catch(() => undefined);
  await db.update(schema.proposals).set({ clientId: client!.id }).where(eq(schema.proposals.id, proposal!.id));

  // --- 5. The build, in progress -----------------------------------------
  const [project] = await db
    .insert(schema.projects)
    .values({
      organisationId,
      clientId: client!.id,
      proposalId: proposal!.id,
      name: `${DEMO_PREFIX}Website and MOT booking build`,
      summary: "Five-page site, online MOT booking, front-desk diary.",
      status: "active",
      startedAt: daysAgo(32, now),
      // A negative number of days ago is in the future: the target is
      // eighteen days ahead of the build rather than behind it.
      targetDate: dayOnly(-18, now),
      deliveredAt: null,
      createdAt: daysAgo(33, now),
    })
    .returning();
  count("projects");

  /**
   * Two done, one active, three pending.
   *
   * `projectProgress` counts done against done-plus-pending, so this draws a
   * spine a third of the way along — which is the whole point of the record.
   * An `active` phase carries a `startedAt` and no `doneAt`; a `pending` one
   * carries neither, because a date on a pending phase would make the
   * timeline read as though the work had already begun.
   */
  const phases = [
    { key: "brief", name: "Brief and discovery", status: "done", started: 32, done: 28 },
    { key: "design", name: "Design", status: "done", started: 27, done: 13 },
    { key: "build", name: "Build", status: "active", started: 12, done: null },
    { key: "review", name: "Content and review", status: "pending", started: null, done: null },
    { key: "launch", name: "Launch", status: "pending", started: null, done: null },
    { key: "care", name: "Care plan", status: "pending", started: null, done: null },
  ] as const;
  for (const [index, phase] of phases.entries()) {
    await db.insert(schema.projectPhases).values({
      organisationId,
      projectId: project!.id,
      clientId: client!.id,
      key: phase.key,
      name: phase.name,
      status: phase.status,
      sort: index + 1,
      startedAt: phase.started === null ? null : daysAgo(phase.started, now),
      doneAt: phase.done === null ? null : daysAgo(phase.done, now),
    });
    count("projectPhases");
  }

  // A null `reachedAt` is a milestone still ahead. The client progress page
  // shows those unticked, which is the state a client actually cares about.
  const milestones = [
    { title: "Discovery call and brief signed off", days: 28, visible: true },
    { title: "Design signed off", days: 13, visible: true },
    { title: "Booking system connected to the diary", days: null, visible: true },
    { title: "Prices and content loaded", days: null, visible: true },
    { title: "Site live", days: null, visible: true },
    { title: "DVLA MOT History API approved", days: null, visible: false },
  ] as const;
  for (const [index, milestone] of milestones.entries()) {
    await db.insert(schema.projectMilestones).values({
      organisationId,
      projectId: project!.id,
      clientId: client!.id,
      title: milestone.title,
      clientVisible: milestone.visible,
      sort: index + 1,
      reachedAt: milestone.days === null ? null : daysAgo(milestone.days, now),
    });
    count("projectMilestones");
  }

  // --- 6. The site, still building ---------------------------------------
  await db.insert(schema.sites).values({
    organisationId,
    clientId: client!.id,
    name: `${DEMO.business} website`,
    primaryUrl: `https://${DEMO.domain}`,
    status: "building",
    platform: "nextjs",
    createdAt: daysAgo(12, now),
  });
  count("sites");

  await db.insert(schema.domains).values({
    organisationId,
    clientId: client!.id,
    name: DEMO.domain,
    registrar: "hostinger",
    registeredAt: daysAgo(30, now),
    expiresAt: daysAgo(-335, now),
    autoRenew: true,
  });
  count("domains");

  // --- 7. The money: one paid, one overdue --------------------------------
  //
  // No subscription row. The care plan starts at launch, and a live
  // subscription on an unlaunched build would put revenue on the Profit
  // screen that has not been earned.
  //
  // No VAT on either. LaunchFlow UK Limited is not VAT registered, so a demo
  // invoice showing 20% is a demo of something that cannot happen.
  const invoices = [
    {
      number: "DEMO-0101",
      status: "paid" as const,
      issued: 33,
      due: 19,
      paid: 30,
      subtotal: 175_000,
      note: "Website build — 50% on acceptance",
    },
    {
      // Overdue by three days. An approved extra rather than a stage payment,
      // because the terms on the proposal say half on acceptance and half on
      // launch — and the build has not launched.
      number: "DEMO-0102",
      status: "overdue" as const,
      issued: 17,
      due: 3,
      paid: null,
      subtotal: 45_000,
      note: "Approved extra — MOT reminder texts, first year",
    },
  ];
  for (const invoice of invoices) {
    await db.insert(schema.invoices).values({
      organisationId,
      clientId: client!.id,
      number: invoice.number,
      status: invoice.status,
      issuedAt: daysAgo(invoice.issued, now),
      dueAt: daysAgo(invoice.due, now),
      paidAt: invoice.paid === null ? null : daysAgo(invoice.paid, now),
      subtotalPence: invoice.subtotal,
      vatPence: 0,
      totalPence: invoice.subtotal,
      lineItems: [{ description: invoice.note, quantity: 1, unitPence: invoice.subtotal }],
    });
    count("invoices");
  }

  // --- 8. The marketing, queued and waiting on him ------------------------
  await db.insert(schema.contentBriefs).values({
    organisationId,
    clientId: client!.id,
    tone: "Straight-talking, local, no jargon. Explain the mechanics without patronising anybody.",
    audience:
      "Drivers within eight miles of Grays. Mostly repeat customers, their families, and people who have just had a bad experience at a chain.",
    services: "MOT, interim and full servicing, brakes, clutches, diagnostics, tyres, air conditioning.",
    offers: "Free MOT retest within ten working days. Courtesy car with any booked service.",
    area: "Grays, Tilbury, Chafford Hundred, Aveley, South Ockendon and the rest of Thurrock.",
    doNotSay:
      "Never quote a repair price without seeing the car. No claims about being cheaper than a named chain. Nothing that reads as a safety guarantee.",
    notes: "The differentiator is that the same mechanic who does the work explains it to you. Lead with that, not with price.",
  });
  count("contentBriefs");

  // Both channels, both disabled. A demo channel that is enabled is a demo
  // the publisher would try to post to, against a Page id that does not
  // exist. The Instagram row is here so the screen shows where a client's
  // Instagram lands once the token carries `instagram_content_publish`.
  for (const channel of [
    { channel: "facebook" as const, externalId: "000000000000001" },
    { channel: "instagram" as const, externalId: "000000000000002" },
  ]) {
    await db.insert(schema.contentChannels).values({
      organisationId,
      clientId: client!.id,
      channel: channel.channel,
      externalId: channel.externalId,
      displayName: `${DEMO.business} (demo)`,
      enabled: false,
    });
    count("contentChannels");
  }

  const period = periodKey(now);
  const posts = [
    {
      channel: "blog" as const,
      kind: "blog_post" as const,
      status: "published" as const,
      days: 8,
      title: "The five things that fail an MOT most often",
      body: "Four of the five take ten minutes to check yourself before you bring the car in. Here they are, in the order we see them.",
    },
    {
      channel: "facebook" as const,
      kind: "social_post" as const,
      status: "awaiting_approval" as const,
      days: -2,
      title: null,
      body: "MOT due this month? You can book online now — pick your slot, no phone call, no waiting for someone to climb out from under a car.",
    },
    {
      channel: "instagram" as const,
      kind: "social_post" as const,
      status: "awaiting_approval" as const,
      days: -3,
      title: null,
      body: "The same mechanic who does the work explains it to you afterwards. No upsell sheet, no jargon. That is the whole pitch.",
    },
    {
      channel: "blog" as const,
      kind: "blog_post" as const,
      status: "awaiting_approval" as const,
      days: -6,
      title: "Interim or full service — which one do you actually need?",
      body: "Garages are vague about this on purpose. Here is the honest answer, based on mileage and what you use the car for.",
    },
    {
      channel: "facebook" as const,
      kind: "social_post" as const,
      status: "scheduled" as const,
      days: -5,
      title: null,
      body: "Free retest within ten working days if anything fails. No second fee, no argument.",
    },
    {
      channel: "facebook" as const,
      kind: "social_post" as const,
      status: "draft" as const,
      days: -9,
      title: null,
      body: "Courtesy car with any booked service. Drop yours off, take ours, carry on with your day.",
    },
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
