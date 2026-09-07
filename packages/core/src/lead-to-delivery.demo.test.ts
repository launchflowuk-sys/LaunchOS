/**
 * A whole job, start to finish, through the real services.
 *
 * Lead arrives → qualified → proposal drafted, priced and sent as a PDF →
 * client reads it and signs → lead becomes a client → project built from the
 * accepted proposal → milestones reached → delivered and handed over.
 *
 * Nothing here is a mock of the flow: every step is the same function the
 * portal calls. It runs inside `withTestDb`, which rolls back, so the local
 * database is exactly as it was afterwards and no email leaves the machine.
 *
 *   DEMO=1 pnpm --filter @launchos/core vitest run src/lead-to-delivery.demo.test.ts
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { setEnqueue } from "./events/emit.js";
import { createLead, updateLeadStatus } from "./leads/leads.js";
import { acceptProposal } from "./proposals/accept.js";
import { createProposal, getPublicProposal } from "./proposals/crud.js";
import { setProposalFollowOn, type ProposalAcceptedJobData } from "./proposals/follow-on.js";
import { recordProposalView } from "./proposals/public.js";
import { sendProposal } from "./proposals/send.js";
import { createProject } from "./projects/crud.js";
import { deliverProject } from "./projects/deliver.js";
import { reachMilestone } from "./projects/milestones.js";
import { getProject } from "./projects/get-project.js";
import { seedOrgWithClient } from "./tasks/test-fixtures.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-demo-"));
const ENV = {
  STORAGE_DIR: storage,
  SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  APP_URL: "https://os.launchflow.co.uk",
  SUPPORT_CONTACT_EMAIL: "hello@launchflow.co.uk",
} as NodeJS.ProcessEnv;

const NOW = new Date("2026-09-07T10:00:00Z");
const money = (p: number) => `£${(p / 100).toFixed(2)}`;
/**
 * The narration is the point of this file, but it would be noise in a normal
 * `pnpm test`. Silent unless asked: `DEMO=1 pnpm --filter @launchos/core vitest
 * run src/lead-to-delivery.demo.test.ts`. The assertions run either way, so the
 * whole chain is still guarded on every test run.
 */
const NARRATE = process.env.DEMO === "1";
const say = (s = "") => { if (NARRATE) console.log(s); };
const step = (n: number, title: string) => say(`\n${"─".repeat(72)}\n ${n}. ${title}\n${"─".repeat(72)}`);

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

describe("a job from first contact to handover", () => {
  it("walks a lead all the way to a delivered project", { timeout: 180_000 }, async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);

      // ─── 1. The lead arrives ────────────────────────────────────────────
      step(1, "A lead arrives");
      const lead = await createLead(db, organisationId, {
        name: "Wajahat Chaudary",
        email: "wajahat@example.test",
        phone: "07700 900123",
        business: "Chaudary Builders",
        message: "Need a website for the building firm, and someone to look after it.",
        source: "website",
        metadata: { page: "/site/contact" },
        actorKind: "client",
      });
      say(`   name      ${lead.name}`);
      say(`   business  ${lead.business}`);
      say(`   source    ${lead.source}   status: ${lead.status}`);

      const [bell] = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.userId, ownerUserId));
      say(`   → owner's bell: "${bell?.title}" linking to ${bell?.link}`);
      expect(lead.status).toBe("new");

      // ─── 2. Qualified ───────────────────────────────────────────────────
      // `converted` is not settable by hand — it is reached only by actually
      // converting, which is why the acceptance later moves it, not this call.
      step(2, "Shoji picks it up");
      const contacted = await updateLeadStatus(db, organisationId, {
        leadId: lead.id, status: "contacted", actorId: ownerUserId,
      });
      say(`   status    ${lead.status} → ${contacted.status}`);

      // ─── 3. The proposal ────────────────────────────────────────────────
      step(3, "A proposal is drafted and priced");
      const { proposal, lines, totals, recipient } = await createProposal(db, organisationId, {
        leadId: lead.id,
        title: "Website and care plan — Chaudary Builders",
        summary: "A new five-page site, then looked after every month.",
        scope: {
          deliverables: ["Five-page website", "Contact and quote forms", "Hosting, backups and updates"],
          outOfScope: ["Paid advertising"],
          timeline: "Live in three weeks from sign-off.",
        },
        pricing: { shape: "setup_plus_monthly", vatNote: "No VAT is charged." },
        lines: [
          { kind: "setup", description: "Design and build", unitPence: 120_000 },
          { kind: "monthly", description: "Hosting and care plan", unitPence: 15_000 },
          { kind: "monthly", description: "Local SEO", unitPence: 10_000 },
        ],
        actorId: ownerUserId,
        now: NOW,
      });
      say(`   reference ${proposal.reference}   status: ${proposal.status}`);
      for (const l of lines) say(`   ${l.kind.padEnd(8)} ${l.description.padEnd(28)} ${money(l.unitPence)}`);
      say(`   → due on acceptance ${money(totals.dueOnAcceptancePence)}, then ${money(totals.recurringMonthlyPence)}/month`);
      say(`   → first year ${money(totals.firstYearPence)}   to ${recipient?.name} <${recipient?.email}>`);

      // ─── 4. Sent ────────────────────────────────────────────────────────
      step(4, "It is sent — a real PDF, behind a signed link");
      const sent = await sendProposal(db, organisationId,
        { proposalId: proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);
      say(`   status    ${proposal.status} → ${sent.proposal.status}`);
      say(`   document  ${sent.document.kind} ${sent.document.reference} (${sent.document.mime})`);
      say(`   sha256    ${sent.document.sha256.slice(0, 32)}…`);
      say(`   → emailed to ${lead.email}; nothing left this machine in the demo`);
      expect(sent.document.mime).toBe("application/pdf");

      // ─── 5. Read, then signed ───────────────────────────────────────────
      step(5, "Wajahat opens it and signs");
      const publicView = await getPublicProposal(db, sent.proposal.publicToken!);
      say(`   public link  /p/${sent.proposal.publicToken!.slice(0, 12)}…`);
      say(`   he sees      "${publicView?.proposal.title}"`);
      await recordProposalView(db, organisationId, { token: sent.proposal.publicToken!, now: NOW });

      const followOn: ProposalAcceptedJobData[] = [];
      setProposalFollowOn(async (j) => { followOn.push(j); });

      const accepted = await acceptProposal(db, organisationId, {
        token: sent.proposal.publicToken!,
        acceptedName: "Wajahat Chaudary",
        acceptedEmail: "wajahat@example.test",
        now: NOW,
      });
      say(`   accepted by  ${accepted.acceptance.acceptedName} at ${accepted.acceptance.acceptedAt.toISOString()}`);
      say(`   → queued for the slow half: ${followOn.length} follow-on job (countersign, payment, project)`);

      // ─── 6. The lead becomes a client ───────────────────────────────────
      step(6, "The lead becomes a client");
      const [client] = await db.select().from(schema.clients)
        .where(eq(schema.clients.organisationId, organisationId))
        .then((rows) => rows.filter((c) => c.name === "Chaudary Builders"));
      say(`   client    ${client?.name}  (${client?.id.slice(0, 8)}…)`);
      const [afterLead] = await db.select().from(schema.leads).where(eq(schema.leads.id, lead.id));
      say(`   lead      status now "${afterLead?.status}"`);
      expect(afterLead?.status).toBe("converted");

      // ─── 7. The project ─────────────────────────────────────────────────
      step(7, "A project is built from the accepted proposal");
      const built = await createProject(db, organisationId, {
        proposalId: proposal.id,
        clientId: client!.id,
        milestones: [
          { title: "Kick-off call and content gathered" },
          { title: "Design signed off" },
          { title: "Build complete on staging" },
          { title: "Live and handed over" },
        ],
        actorId: ownerUserId,
        now: NOW,
      });
      say(`   project   "${built.project.name}"  status: ${built.project.status}`);
      say(`   milestones ${built.milestones.length}`);
      for (const m of built.milestones) say(`     ☐ ${m.title}`);

      // ─── 8. The work ────────────────────────────────────────────────────
      step(8, "The work happens; the client watches it move");
      for (const m of built.milestones.slice(0, 3)) {
        await reachMilestone(db, organisationId, {
          projectId: built.project.id, milestoneId: m.id, actorId: ownerUserId,
        });
        const detail = await getProject(db, organisationId, built.project.id);
        say(`     ☑ ${m.title.padEnd(38)} → ${detail!.progress.percent}%`);
      }

      // ─── 9. Delivered ───────────────────────────────────────────────────
      step(9, "Delivered and handed over");
      const last = built.milestones.at(-1)!;
      await reachMilestone(db, organisationId, {
        projectId: built.project.id, milestoneId: last.id, actorId: ownerUserId,
      });
      const delivered = await deliverProject(db, organisationId, {
        projectId: built.project.id,
        note: "Site live at chaudarybuilders.co.uk, handed over with a walkthrough.",
        actorId: ownerUserId,
      });
      const final = (await getProject(db, organisationId, built.project.id))!.progress;
      say(`     ☑ ${last.title}`);
      say(`   status    ${built.project.status} → ${delivered.project.status}`);
      say(`   progress  ${final.percent}%`);

      // ─── 10. The trail ──────────────────────────────────────────────────
      step(10, "What the audit log kept");
      const audit = await db.select().from(schema.auditLog)
        .where(eq(schema.auditLog.organisationId, organisationId));
      const actions = audit.map((a) => a.action).sort();
      say(`   ${audit.length} entries, every write attributed:`);
      for (const a of [...new Set(actions)]) say(`     ${a}`);

      say(`\n${"═".repeat(72)}`);
      say(` Lead → qualified → proposal → signed → client → project → delivered.`);
      say(` Rolled back: your local database is untouched.`);
      say(`${"═".repeat(72)}\n`);

      expect(delivered.project.status).toBe("delivered");
    });
  });
});
