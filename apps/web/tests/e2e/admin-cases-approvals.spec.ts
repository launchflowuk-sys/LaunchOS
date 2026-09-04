import { createTicket } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { and, eq, sql } from "drizzle-orm";
import { DATABASE_URL, OWNER } from "./seed-credentials";
import { signIn } from "./sign-in";

// The dev server compiles each route the first time it is requested, and this
// spec is the first thing to ask for /inbox, /cases and /cases/[id].
const COLD_COMPILE = 60_000;

const db = createDb(DATABASE_URL);
const stamp = Date.now();
const subject = `E2E contact form down ${stamp}`;
const note = `Checked the SMTP logs at ${stamp}`;
const toolUseId = `toolu_e2e_${stamp}`;
const approvalTitle = `E2E reply to client ${stamp}`;
const draftedReply = `Thanks for letting us know about the contact form. ${stamp}`;

let organisationId = "";
let ownerUserId = "";
let ownerName = "";
let ticketId = "";
let conversationId = "";
let runId = "";
let approvalId = "";

test.beforeAll(async () => {
  const [organisation] = await db
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  const [owner] = await db.select().from(schema.user).where(eq(schema.user.email, OWNER.email));
  if (!owner) throw new Error(`seed owner ${OWNER.email} not found — run \`pnpm db:seed\` first`);
  ownerUserId = owner.id;
  ownerName = owner.name;

  const [client] = await db
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.organisationId, organisationId))
    .limit(1);
  if (!client) throw new Error("seed client not found — run `pnpm db:seed` first");

  // Nothing in the seed opens a case, so the spec makes its own through core:
  // the same path the inbound email webhook takes, minus the mail server.
  const created = await createTicket(db, organisationId, {
    clientId: client.id,
    subject,
    body: "Our contact form stopped sending anything through this morning.",
    severity: "medium",
    source: "email",
    actorKind: "system",
  });
  ticketId = created.ticket.id;
  conversationId = created.conversation.id;

  // A parked approval, shaped exactly as the policy gate parks one: the
  // resume kernel matches `payload.toolUseId` against `metadata.pending`.
  const [run] = await db
    .insert(schema.agentRuns)
    .values({
      organisationId,
      agentKey: "support-triage",
      trigger: "event",
      status: "awaiting_approval",
      input: { ticketId },
      metadata: {
        pending: {
          messages: [{ role: "assistant", content: [] }],
          completedResults: [],
          awaitingToolUseId: toolUseId,
          remainingToolUseIds: [],
        },
      },
    })
    .returning();
  runId = run!.id;

  const [approval] = await db
    .insert(schema.approvals)
    .values({
      organisationId,
      runId,
      kind: "message_send",
      title: approvalTitle,
      payload: {
        toolName: "messages_reply_to_client",
        input: { conversationId, body: draftedReply },
        toolUseId,
      },
    })
    .returning();
  approvalId = approval!.id;
});

test.afterAll(async () => {
  // The queued resume would fail once its run is gone, so it goes first. The
  // pgboss schema only exists once something has sent a job, hence the catch.
  try {
    await db.execute(sql`delete from pgboss.job where name = 'agent.resume' and data->>'approvalId' = ${approvalId}`);
  } catch {
    // no queue to clean up
  }
  if (approvalId) {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.targetId, approvalId));
  }
  if (approvalId) await db.delete(schema.approvals).where(eq(schema.approvals.id, approvalId));
  if (runId) await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  // tickets first: ticket_events cascade from the ticket, messages from the
  // conversation, and tickets.conversation_id points at the conversation.
  if (ticketId) await db.delete(schema.tickets).where(eq(schema.tickets.id, ticketId));
  if (conversationId) await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
});

test("open cases: list, thread, internal note, assign and status", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  // /tickets is the Plan 1 route and must still land on the renamed screen.
  await page.goto("/tickets");
  await expect(page).toHaveURL(/\/cases$/);
  await expect(page.getByRole("heading", { level: 1, name: "Open Cases" })).toBeVisible({ timeout: COLD_COMPILE });

  // The nav entry points at the new route too.
  await page.getByRole("navigation").getByRole("link", { name: "Open Cases" }).click();
  await expect(page).toHaveURL(/\/cases$/);

  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible({ timeout: COLD_COMPILE });
  // The opening message the client wrote is on the thread.
  await expect(page.getByText("Our contact form stopped sending anything through this morning.")).toBeVisible();
  // Nothing has triaged it yet.
  await expect(page.getByText("Not triaged yet.")).toBeVisible();

  // An internal note never leaves LaunchOS, and lands on the thread labelled.
  const noteForm = page.getByRole("form", { name: "Internal note" });
  await noteForm.locator('textarea[name="body"]').fill(note);
  await noteForm.getByRole("button", { name: "Add internal note" }).click();
  await expect(page.getByText(note)).toBeVisible({ timeout: 30_000 });

  // Assign to the owner.
  const assignForm = page.getByRole("form", { name: "Assign case" });
  await assignForm.locator('select[name="assignedUserId"]').selectOption(ownerUserId);
  await assignForm.getByRole("button", { name: "Assign" }).click();
  // Wait for the write to land before starting the next one.
  await expect(page.getByText("Case assigned")).toBeVisible({ timeout: 30_000 });

  // Move it along. The header badge is the one place the *current* status is
  // rendered — the buttons below carry every status, current or not.
  await page.getByRole("form", { name: "Set status in_progress" }).getByRole("button").click();
  await expect(page.getByRole("group", { name: "Case status" })).toContainText("in progress", { timeout: 30_000 });

  // Both writes show up on the list, which is the screen Shoji actually lives on.
  await page.goto("/cases");
  const row = page.getByRole("row", { name: new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
  await expect(row).toContainText(ownerName);
  await expect(row).toContainText("in progress");
});

test("inbox lists the conversation and opens the thread", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  await page.getByRole("navigation").getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("form", { name: "Reply" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Internal note" })).toBeVisible();
  // The thread links back to the case the conversation opened.
  await expect(page.getByRole("link", { name: "Open case" })).toHaveAttribute("href", `/cases/${ticketId}`);
});

test("approving a parked tool call queues the agent resume", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  await page.getByRole("navigation").getByRole("link", { name: "Approvals" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(
    page.getByText("Approving runs the tool and resumes the agent. Rejecting tells the agent why and lets it continue."),
  ).toBeVisible();

  const card = page.locator("li").filter({ hasText: approvalTitle });
  await expect(card).toContainText("awaiting");
  await expect(card).toContainText("messages_reply_to_client");
  await expect(card).toContainText(draftedReply);
  await expect(card.getByRole("link", { name: "view run" })).toHaveAttribute("href", `/agents/runs/${runId}`);

  const approveForm = card.getByRole("form", { name: "Approve approval" });
  await approveForm.locator('input[name="note"]').fill("Reads well, send it.");
  await approveForm.getByRole("button", { name: "Approve" }).click();

  // The decision is queued for the worker, which is what actually runs the tool
  // and resumes the run. The job carries no approver: the kernel reads that off
  // the approvals row.
  await expect
    .poll(
      async () => {
        const rows = await db.execute(
          sql`select data from pgboss.job where name = 'agent.resume' and data->>'approvalId' = ${approvalId}`,
        );
        return (rows as unknown as { data: Record<string, unknown> }[])[0]?.data ?? null;
      },
      { timeout: 30_000, message: "expected an agent.resume job for this approval" },
    )
    .toMatchObject({
      organisationId,
      runId,
      approvalId,
      decision: "approved",
      note: "Reads well, send it.",
    });

  // `decideApproval` is the single writer of the decision, and it runs here in
  // the web request: the approver on the card, in the audit log and in the
  // database can never disagree, and a resume that never happens cannot leave
  // the row decided-but-pending. The kernel reads all of this back.
  const [decided] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  expect(decided!.status).toBe("approved");
  expect(decided!.decidedBy).toBe(ownerUserId);
  expect(decided!.decisionNote).toBe("Reads well, send it.");

  // A run-backed decision is audited as queued, not as done: the tool has not
  // run yet, the worker is what runs it.
  const audit = await db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.organisationId, organisationId),
        eq(schema.auditLog.targetType, "approval"),
        eq(schema.auditLog.targetId, approvalId),
      ),
    );
  expect(audit.map((a) => a.action)).toContain("approval.approved_queued");
  expect(audit.map((a) => a.action)).not.toContain("approval.approved");
});
