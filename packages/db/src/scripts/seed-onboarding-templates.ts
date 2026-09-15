/**
 * Loads the onboarding task templates a new client's task list is generated
 * from.
 *
 *   pnpm db:seed-onboarding-templates -- --dry-run   # print the plan
 *   pnpm db:seed-onboarding-templates -- --yes       # apply it
 *
 * Why this exists. `generateOnboardingTasks` turns a client's package into a
 * task list by reading `task_templates`, and on 15 Sep 2026 production had
 * **none** — for any phase. So `client.created` fanned out to a generator that
 * wrote nothing, every new client arrived with an empty board, and the welcome
 * email's "we are already lining up your onboarding" was not true of anything.
 *
 * The list below is the work that actually has to happen when somebody buys a
 * plan, in the order it happens, with the accesses named. It is not aspiration:
 * every access mentioned is one LaunchOS genuinely needs before it can do the
 * thing the package sold.
 *
 * **Idempotent, matched on (package, phase, title).** Re-running tops up what
 * is missing and touches nothing that exists, so it is safe after adding a
 * template here and safe to run against a database somebody has since edited
 * by hand. It never deletes: a template Shoji has reworded is his, and the
 * matching key is the title, so a renamed one simply stays.
 *
 * `offset_days` is days from the client being created — `generateOnboardingTasks`
 * sets each task's due date to `client.created_at + offset`. They are spread
 * across a fortnight rather than all dated today, because ten tasks all due on
 * day zero is a list nobody can work from.
 */
import { pathToFileURL } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import { createDb, type Db } from "../client.js";
import { loadRootEnv, ROOT_ENV_FILE } from "../env-target.js";
import * as schema from "../schema/index.js";
import type { TaskAssigneeRole, TaskKind } from "../schema/index.js";

interface TemplateSpec {
  title: string;
  kind: TaskKind;
  offsetDays: number;
  role: TaskAssigneeRole;
  descriptionMd: string;
  checklist?: string[];
  /** Proof required before the task can be closed. Only where proof is cheap and the cost of assuming is high. */
  evidence?: { required: boolean; kinds: ("link" | "screenshot" | "checklist")[] };
}

/** LaunchFlow's Business portfolio id — what a client enters to grant Partner access. */
const PARTNER_BUSINESS_ID = "925233161834616";

/**
 * Every client, whatever they bought. The website and the relationship.
 */
const GLOBAL: TemplateSpec[] = [
  {
    title: "Book the kick-off call",
    kind: "other",
    offsetDays: 0,
    role: "owner",
    descriptionMd:
      "Send the booking link and get a date in the diary. Everything else moves faster after twenty minutes on the phone, and a client who has spoken to a person does not chase.",
    checklist: ["Booking link sent", "Date agreed and in the diary"],
  },
  {
    title: "Get domain and hosting access",
    kind: "dns",
    offsetDays: 1,
    role: "owner",
    descriptionMd:
      "The registrar login or a transfer code, who runs the DNS, and where the site is hosted today. This is the one that holds everything up if it is left — a launch cannot happen without the DNS, and chasing it on launch day is how a date slips.",
    checklist: ["Registrar access or transfer code", "DNS provider known", "Current host and control panel"],
    evidence: { required: true, kinds: ["checklist"] },
  },
  {
    title: "Collect the business facts",
    kind: "other",
    offsetDays: 1,
    role: "any",
    descriptionMd:
      "Services in their own words, the areas they cover, phone, opening hours, and the address as it should appear. These end up on every page and in the Google listing, so getting them wrong is expensive to unpick later.",
    checklist: ["Services", "Areas covered", "Phone and opening hours", "Address as it should appear"],
  },
  {
    title: "Collect logo, photos and brand bits",
    kind: "other",
    offsetDays: 2,
    role: "any",
    descriptionMd:
      "The logo in the best quality they have, photos of the actual work, and any colours or fonts they are attached to. Ask what they do *not* want used — a photo they hate on the homepage is a bad first week.",
    checklist: ["Logo file", "Photos of their work", "Colours or fonts to keep"],
  },
  {
    title: "Add the website to LaunchOS and put a monitor on it",
    kind: "deploy",
    offsetDays: 3,
    role: "any",
    descriptionMd:
      "Websites → add the site with its primary URL, then a monitor on it. Until this is done nothing watches their site, no thumbnail appears, and the care plan they are paying for is not actually running.",
    evidence: { required: true, kinds: ["link"] },
  },
  {
    title: "Show them round the portal",
    kind: "handover",
    offsetDays: 5,
    role: "owner",
    descriptionMd:
      "Where the invoices are, where anything waiting on them appears, and where they can see progress. Five minutes on the kick-off call is enough, and it stops the emails that start \"sorry, where do I…\".",
  },
  {
    title: "Check their support email actually routes",
    kind: "support",
    offsetDays: 7,
    role: "any",
    descriptionMd:
      "Send one message to their support address and confirm it lands as a case. Inbound routing is the thing that fails silently — a client emailing into a void for a fortnight is worse than having no address at all.",
    evidence: { required: true, kinds: ["screenshot"] },
  },
];

/**
 * The content packages. Standard and Growth get the same four, because
 * templates are scoped to one package and Growth is Standard plus advertising
 * — the duplication is the data model, not an oversight.
 */
const CONTENT: TemplateSpec[] = [
  {
    title: "Fill in the content brief",
    kind: "content",
    offsetDays: 2,
    role: "owner",
    descriptionMd:
      "Tone, who they are talking to, services, current offers, the area — and **what must never be said**. That last field is the one that matters: no guarantees, no medical claims, no discount language where it reads badly. Everything written for them is generated from this, so a thin brief produces thin posts.",
    checklist: ["Tone and audience", "Services and offers", "Area", "What never to say"],
  },
  {
    title: "Get Facebook Page and Instagram access",
    kind: "social",
    offsetDays: 3,
    role: "owner",
    descriptionMd: [
      "Send them `docs/client/connecting-your-social-accounts` and walk it through if needed. Three things have to be true:",
      "",
      `1. They add LaunchFlow as a **Partner** on their Page — business ID \`${PARTNER_BUSINESS_ID}\` — with Content access.`,
      "2. **You** assign that Page to the `launchos` system user: Business Settings → Users → System Users → Add Assets. Being in the portfolio is not enough, and this is the step that gets missed.",
      "3. Their Instagram is a **Business or Creator** account and linked to that Page. No API can post to a personal account — Meta's rule, no workaround.",
      "",
      "Then put the Page id into their channel row in LaunchOS; the Instagram id is read off the Page automatically.",
    ].join("\n"),
    checklist: ["Partner access granted", "Page assigned to the system user", "Instagram is Business/Creator and linked", "Page id in LaunchOS"],
    evidence: { required: true, kinds: ["checklist"] },
  },
  {
    title: "Get Google Business Profile access as Manager",
    kind: "gbp",
    offsetDays: 5,
    role: "any",
    descriptionMd:
      "**Manager, never Owner.** Manager is enough to post updates and it leaves them in control of their own listing, which is the answer they want to hear when they ask. They also need the profile claimed before any of it works.",
    checklist: ["Profile claimed by them", "LaunchFlow added as Manager"],
  },
  {
    title: "Agree the first month's content plan",
    kind: "content",
    offsetDays: 7,
    role: "owner",
    descriptionMd:
      "What is going out, roughly when, and on which channels. Show them the first few drafts so the voice is agreed before a month of posts is written in the wrong one. Nothing publishes without their approval either way.",
  },
];

/** Growth only: the advertising and the access to Shoji it sells. */
const ADS: TemplateSpec[] = [
  {
    title: "Agree the ad budget and where the leads land",
    kind: "other",
    offsetDays: 3,
    role: "owner",
    descriptionMd:
      "A daily budget said out loud, and the form or phone the leads arrive on. Also agree how many new clients can be onboarded at once — spend that outruns capacity turns the best part of the offer into the worst part of the experience.",
    checklist: ["Daily budget agreed", "Where leads land", "Concurrent-onboarding cap agreed"],
  },
  {
    title: "Prove the conversion fires before any campaign is enabled",
    kind: "seo",
    offsetDays: 5,
    role: "owner",
    descriptionMd:
      "Submit the real form once by hand. Confirm it appears in GA4 as a key event, then that it has imported into Google Ads. **Do not enable a campaign whose conversion is not firing and imported** — bidding without one is paying to optimise on clicks, which is not the thing you want.",
    checklist: ["Fired by hand", "Visible in GA4 as a key event", "Imported and visible in Google Ads"],
    evidence: { required: true, kinds: ["screenshot"] },
  },
  {
    title: "Set up the monthly call and the WhatsApp line",
    kind: "other",
    offsetDays: 7,
    role: "owner",
    descriptionMd:
      "Growth sells a monthly call, same-day replies on a working day, and WhatsApp. Put the recurring call in the diary now and give them the number — a promise nobody schedules is a promise that quietly lapses.",
    checklist: ["Recurring monthly call in the diary", "WhatsApp number given"],
  },
];

/** Which package slugs get which extra sets. A slug absent from here gets the global list only. */
const BY_SLUG: Record<string, TemplateSpec[]> = {
  standard: CONTENT,
  growth: [...CONTENT, ...ADS],
};

export interface SeedResult {
  created: number;
  skipped: number;
  lines: string[];
}

export async function seedOnboardingTemplates(
  db: Db,
  organisationId: string,
  options: { apply: boolean } = { apply: false },
): Promise<SeedResult> {
  const packages = await db
    .select({ id: schema.packages.id, name: schema.packages.name, slug: schema.packages.slug })
    .from(schema.packages)
    .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.active, true), isNull(schema.packages.deletedAt)));

  // `packageId: null` is the global set — `generateOnboardingTasks` includes it
  // for any client that has a package.
  const groups: { packageId: string | null; label: string; specs: TemplateSpec[] }[] = [
    { packageId: null, label: "every package", specs: GLOBAL },
    ...packages.flatMap((pkg) => {
      const extra = BY_SLUG[pkg.slug];
      return extra ? [{ packageId: pkg.id, label: pkg.name, specs: extra }] : [];
    }),
  ];

  const lines: string[] = [];
  let created = 0;
  let skipped = 0;

  for (const group of groups) {
    for (const [index, spec] of group.specs.entries()) {
      const existing = await db
        .select({ id: schema.taskTemplates.id })
        .from(schema.taskTemplates)
        .where(and(
          eq(schema.taskTemplates.organisationId, organisationId),
          group.packageId === null ? isNull(schema.taskTemplates.packageId) : eq(schema.taskTemplates.packageId, group.packageId),
          eq(schema.taskTemplates.phase, "onboarding"),
          eq(schema.taskTemplates.title, spec.title),
          isNull(schema.taskTemplates.deletedAt),
        ));

      if (existing.length > 0) {
        skipped += 1;
        lines.push(`  = [${group.label}] ${spec.title}`);
        continue;
      }

      lines.push(`  + [${group.label}] day ${spec.offsetDays} · ${spec.title}`);
      created += 1;
      if (!options.apply) continue;

      await db.insert(schema.taskTemplates).values({
        organisationId,
        packageId: group.packageId,
        phase: "onboarding",
        kind: spec.kind,
        title: spec.title,
        descriptionMd: spec.descriptionMd,
        offsetDays: spec.offsetDays,
        recurrence: "none",
        defaultAssigneeRole: spec.role,
        sortOrder: (group.packageId === null ? 0 : 100) + index,
        checklist: spec.checklist ?? [],
        evidence: {
          required: spec.evidence?.required ?? false,
          kinds: spec.evidence?.kinds ?? [],
          checklist: [],
        },
      });
    }
  }

  return { created, skipped, lines };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--yes");
  const dryRun = args.includes("--dry-run");
  if (!apply && !dryRun) {
    console.error("say --dry-run to see the plan, or --yes to apply it");
    process.exitCode = 1;
    return;
  }

  loadRootEnv(ROOT_ENV_FILE);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }

  const db = createDb(url, { max: 2 });
  const [org] = await db.select({ id: schema.organisations.id, name: schema.organisations.name }).from(schema.organisations).limit(1);
  if (!org) {
    console.error("no organisations exist");
    process.exitCode = 1;
    return;
  }

  console.log(`organisation: ${org.name}`);
  const result = await seedOnboardingTemplates(db, org.id, { apply });
  for (const line of result.lines) console.log(line);
  console.log(`\n${apply ? "created" : "would create"} ${result.created}, already present ${result.skipped}`);
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error("seed-onboarding-templates failed", error);
    process.exitCode = 1;
  });
}
