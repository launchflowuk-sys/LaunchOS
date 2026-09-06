import {
  createClientUser,
  createTask,
  createTaskTemplate,
  createTicket,
  evidenceFromTemplate,
  getAssignmentRules,
  setAssignmentRules,
  setEnqueue,
  updateTicket,
} from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test, type Page } from "@playwright/test";
import { and, eq, gte, inArray, like, or } from "drizzle-orm";
import { DATABASE_URL, OWNER } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * Remote pack, web half A: proof of work gating Done on a task, the
 * assignment rules on Settings → Organisation, a client rating a resolved case
 * from the portal, and the "Alerts on this device" section on /account.
 *
 * Everything it needs beyond the seed it makes itself — a template with a
 * proof rule, a task from it, a portal user for Grays CabLine and a resolved
 * case — and removes in `afterAll`. The assignment rules are put back to what
 * they were.
 */
const COLD_COMPILE = 120_000;

const db = createDb(DATABASE_URL);
// `updateTicket` to resolved emits `message.queued` for the "Was this sorted?"
// invite; this process has no queue, and the default no-op is what we want.
setEnqueue(async () => {});

const STAMP = Date.now();
const STARTED = new Date();
const TEMPLATE_TITLE = `Launch checks ${STAMP}`;
const TASK_TITLE = `Put the new site live ${STAMP}`;
const PROOF_ITEM = "Client signed off";
const LINK = `https://example.test/live-${STAMP}`;
const PORTAL_EMAIL = `portal.remote-a.${STAMP}@grayscabline.example`;
const TICKET_SUBJECT = `Contact form fixed ${STAMP}`;
const COMMENT = `Sorted the same afternoon (${STAMP}).`;

let organisationId: string;
let ownerUserId: string;
let clientId: string;
let templateId: string;
let taskId: string;
let portalUserId: string;
let portalPassword: string;
let ticketId: string;
let conversationId: string;
let previousRules: { support: string; tasks: string };

async function signInAsPortalUser(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(PORTAL_EMAIL);
  await page.getByLabel("Password").fill(portalPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/portal", { timeout: COLD_COMPILE });
}

async function signInAsOwner(page: Page): Promise<void> {
  await page.context().clearCookies();
  await signIn(page);
}

test.beforeAll(async () => {
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  const [owner] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, OWNER.email));
  if (!owner) throw new Error("seeded owner not found — run `pnpm db:seed` first");
  ownerUserId = owner.id;

  const [client] = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, "Grays CabLine")));
  if (!client) throw new Error("seed client Grays CabLine not found — run `pnpm db:seed` first");
  clientId = client.id;

  previousRules = await getAssignmentRules(db, organisationId);

  // A template that demands a link and a ticked proof item, and a task made from it.
  const template = await createTaskTemplate(db, organisationId, {
    phase: "onboarding",
    kind: "deploy",
    title: TEMPLATE_TITLE,
    evidence: { required: true, kinds: ["link", "checklist"], checklist: [PROOF_ITEM] },
    actorKind: "user",
    actorId: ownerUserId,
  });
  templateId = template.id;
  const task = await createTask(db, organisationId, {
    clientId,
    templateId,
    title: TASK_TITLE,
    phase: "onboarding",
    kind: "deploy",
    evidence: evidenceFromTemplate(template),
    actorKind: "user",
    actorId: ownerUserId,
  });
  taskId = task.id;

  // A portal user and a resolved, client-visible case for them to rate.
  const created = await createClientUser(db, organisationId, { clientId, email: PORTAL_EMAIL, name: "Remote Pack Tester" });
  portalUserId = created.user.id;
  portalPassword = created.oneTimePassword;

  const raised = await createTicket(db, organisationId, {
    clientId,
    subject: TICKET_SUBJECT,
    body: "The contact form was not sending.",
    severity: "medium",
    source: "portal",
    actorKind: "client",
    actorId: portalUserId,
  });
  ticketId = raised.ticket.id;
  conversationId = raised.conversation.id;
  await updateTicket(db, organisationId, { ticketId, status: "resolved", actorKind: "user", actorId: ownerUserId });
});

test.afterAll(async () => {
  if (!organisationId) return;
  if (previousRules) {
    await setAssignmentRules(db, organisationId, {
      rules: { support: previousRules.support as "off", tasks: previousRules.tasks as "off" },
      actorId: ownerUserId,
    });
  }
  const targets = [taskId, templateId, ticketId, conversationId, portalUserId].filter(Boolean);
  if (ticketId) await db.delete(schema.tickets).where(eq(schema.tickets.id, ticketId));
  if (conversationId) await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
  if (taskId) await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
  if (templateId) await db.delete(schema.taskTemplates).where(eq(schema.taskTemplates.id, templateId));
  if (portalUserId) await db.delete(schema.user).where(eq(schema.user.id, portalUserId));
  if (targets.length > 0) await db.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, targets));
  await db
    .delete(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.organisationId, organisationId),
        eq(schema.auditLog.action, "organisation.assignment_updated"),
        gte(schema.auditLog.createdAt, STARTED),
      ),
    );
  const marker = `%${STAMP}%`;
  await db.delete(schema.activityEvents).where(or(like(schema.activityEvents.title, marker), like(schema.activityEvents.link, `%${ticketId}%`)));
  await db.delete(schema.notifications).where(or(like(schema.notifications.title, marker), like(schema.notifications.link, `%${ticketId}%`)));
});

test("task evidence blocks Done until the link is added and the proof item ticked", async ({ page }) => {
  test.setTimeout(300_000);
  await signInAsOwner(page);
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole("heading", { name: TASK_TITLE })).toBeVisible({ timeout: COLD_COMPILE });

  // The button is there, disabled, and says exactly what core would refuse for.
  const done = page.getByRole("button", { name: "Mark done" });
  await expect(done).toBeDisabled();
  await expect(page.getByText(`Still needed: a link to the delivered work; tick "${PROOF_ITEM}".`).first()).toBeVisible();

  await page.getByLabel("Link to the delivered work").fill(LINK);
  await page.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByRole("link", { name: LINK })).toBeVisible({ timeout: 30_000 });
  await expect(done).toBeDisabled();

  await page.getByRole("button", { name: `Tick ${PROOF_ITEM}` }).click();
  await expect(page.getByRole("button", { name: `Untick ${PROOF_ITEM}` })).toBeVisible({ timeout: 30_000 });
  await expect(done).toBeEnabled();

  await done.click();
  await expect(async () => {
    const [row] = await db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(row?.status).toBe("done");
  }).toPass({ timeout: 30_000 });
  // Once done the button goes and the record stays read-only.
  await expect(done).toHaveCount(0);
  await expect(page.getByRole("link", { name: LINK })).toBeVisible();
});

test("assignment settings save to the organisation", async ({ page }) => {
  test.setTimeout(300_000);
  await signInAsOwner(page);
  await page.goto("/settings/organisation");
  await expect(page.getByRole("heading", { name: "Assignment" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByLabel("Support cases").selectOption("least_open");
  await page.getByLabel("Generated tasks").selectOption("by_role_least_open");
  await page.getByRole("button", { name: "Save assignment rules" }).click();
  await expect(page.getByText("Assignment rules saved")).toBeVisible({ timeout: 30_000 });

  await expect(async () => {
    expect(await getAssignmentRules(db, organisationId)).toEqual({ support: "least_open", tasks: "by_role_least_open" });
  }).toPass({ timeout: 15_000 });
});

test("a client rates a resolved case from the link's pre-selected score", async ({ page }) => {
  test.setTimeout(300_000);
  await signInAsPortalUser(page);
  await page.goto(`/portal/support/${ticketId}/rate?score=4`);
  await expect(page.getByRole("heading", { name: "Was this sorted?" })).toBeVisible({ timeout: COLD_COMPILE });

  await expect(page.getByRole("radio", { name: "4 — Good" })).toBeChecked();
  await page.getByLabel("Anything you would like to add? (optional)").fill(COMMENT);
  await page.getByRole("button", { name: "Send rating" }).click();
  // The action revalidates the page, so the form is replaced by the
  // thank-you state rather than showing its own inline success line.
  await expect(page.getByText("You rated this request 4 out of 5")).toBeVisible({ timeout: 30_000 });

  const [rating] = await db.select().from(schema.ticketRatings).where(eq(schema.ticketRatings.ticketId, ticketId));
  expect(rating?.score).toBe(4);
  expect(rating?.comment).toBe(COMMENT);
  expect(rating?.clientUserId).toBe(portalUserId);

  // Coming back shows the thank-you state rather than an empty form.
  await page.goto(`/portal/support/${ticketId}/rate`);
  await expect(page.getByText("You rated this request 4 out of 5")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("button", { name: "Send rating" })).toHaveCount(0);
});

test("the account page carries the alerts section", async ({ page }) => {
  test.setTimeout(300_000);
  await signInAsOwner(page);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Alerts on this device" })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByText("Urgent things — an incident opening")).toBeVisible();
  // With or without VAPID keys the switch is present; only its state differs.
  await expect(page.getByRole("button", { name: /alerts on this device/ })).toBeVisible();
});
