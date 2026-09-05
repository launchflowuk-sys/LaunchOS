import { clockOut, createMember, setMemberPermissions } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { and, eq, gte, inArray, like, or } from "drizzle-orm";
import { DATABASE_URL, OWNER } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * The owner layer: the clock in the top bar and the timesheet it feeds, the
 * team health page, the Ops Briefs page, and a permission set that takes an
 * area away from a staff member — in the rail and behind it.
 *
 * It makes one staff member of its own and removes every row it wrote in
 * `afterAll`; the owner's time entries from the run are removed too.
 */
// The dev server compiles each route the first time it is requested, measured
// at up to 35s cold, so the first assertion on a new screen gets far longer
// than the 5s default.
const COLD_COMPILE = 120_000;

const db = createDb(DATABASE_URL);

const STAMP = Date.now();
const STAFF_EMAIL = `e2e-owner-layer-${STAMP}@example.test`;
const STAFF_NAME = `E2E Owner Layer ${STAMP}`;
const STARTED = new Date();

let organisationId: string;
let ownerUserId: string;
/** The owner as the timesheet names them: the membership's display name, else the account name. */
let ownerName: string;
let staffUserId: string;
let staffMemberId: string;
let staffPassword: string;

/**
 * Follows a link and waits for the destination to render. A plain `click()` is
 * not enough against `next dev`: a Fast Refresh full reload cancels the
 * in-flight client navigation. Same helper as `admin-team.spec.ts`.
 */
async function follow(page: Page, link: Locator, heading: string | RegExp): Promise<void> {
  const target = page.getByRole("heading", { name: heading });
  await expect(async () => {
    await link.click();
    await expect(target).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: COLD_COMPILE, intervals: [1_000] });
}

/** Presses a button and waits for what it should produce, retrying past a Fast Refresh reload. */
async function press(page: Page, button: Locator, produces: Locator): Promise<void> {
  await expect(async () => {
    await button.click();
    await expect(produces).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: COLD_COMPILE, intervals: [1_000] });
}

async function signInAs(page: Page, email: string, password: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/", { timeout: COLD_COMPILE });
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: COLD_COMPILE });
}

test.beforeAll(async () => {
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  const [owner] = await db
    .select({
      userId: schema.user.id,
      name: schema.user.name,
      displayName: schema.organisationMembers.displayName,
    })
    .from(schema.user)
    .innerJoin(schema.organisationMembers, eq(schema.organisationMembers.userId, schema.user.id))
    .where(and(eq(schema.user.email, OWNER.email), eq(schema.organisationMembers.organisationId, organisationId)));
  if (!owner) throw new Error("seeded owner not found — run `pnpm db:seed` first");
  ownerUserId = owner.userId;
  ownerName = owner.displayName ?? owner.name;
  // A run that died clocked in would make "Clock in" invisible from the start.
  await clockOut(db, organisationId, { userId: ownerUserId });

  const { member, oneTimePassword } = await createMember(db, organisationId, {
    email: STAFF_EMAIL,
    displayName: STAFF_NAME,
    role: "staff",
    invitedBy: ownerUserId,
  });
  staffMemberId = member.id;
  staffUserId = member.userId;
  staffPassword = oneTimePassword;
  await setMemberPermissions(db, organisationId, {
    memberId: staffMemberId,
    permissions: { content: false },
    actorId: ownerUserId,
  });
});

test.afterAll(async () => {
  if (!organisationId) return;
  await clockOut(db, organisationId, { userId: ownerUserId });
  await db
    .delete(schema.timeEntries)
    .where(and(eq(schema.timeEntries.userId, ownerUserId), gte(schema.timeEntries.createdAt, STARTED)));
  await db.delete(schema.auditLog).where(
    and(
      eq(schema.auditLog.organisationId, organisationId),
      gte(schema.auditLog.createdAt, STARTED),
      or(eq(schema.auditLog.actorId, ownerUserId), eq(schema.auditLog.actorId, staffUserId)),
    ),
  );

  if (!staffUserId) return;
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, [staffMemberId, staffUserId]));
  await db.delete(schema.activityEvents).where(like(schema.activityEvents.title, `%${STAFF_NAME}%`));
  await db.delete(schema.notifications).where(like(schema.notifications.title, `%${STAFF_NAME}%`));
  await db.delete(schema.organisationMembers).where(eq(schema.organisationMembers.id, staffMemberId));
  await db.delete(schema.session).where(eq(schema.session.userId, staffUserId));
  await db.delete(schema.account).where(eq(schema.account.userId, staffUserId));
  await db.delete(schema.user).where(eq(schema.user.id, staffUserId));
});

test("clock in from the top bar, see the running row on the timesheet, clock out", async ({ page }) => {
  test.setTimeout(300_000);

  await signIn(page);

  await press(page, page.getByRole("button", { name: "Clock in" }), page.getByTestId("clock-running"));
  await expect(page.getByRole("button", { name: "Clock out" })).toBeVisible();

  // The entry is a row in the database, running.
  const [running] = await db
    .select({ id: schema.timeEntries.id, endedAt: schema.timeEntries.endedAt })
    .from(schema.timeEntries)
    .where(and(eq(schema.timeEntries.userId, ownerUserId), gte(schema.timeEntries.createdAt, STARTED)));
  expect(running?.endedAt).toBeNull();

  // The week's grid shows the owner's row, on the clock now.
  await follow(page, page.getByRole("navigation").getByRole("link", { name: "Timesheets" }), "Timesheets");
  const row = page.getByRole("row").filter({ hasText: ownerName });
  await expect(row).toBeVisible();
  await expect(row.getByText("running")).toBeVisible();

  // Clocking out from the top bar closes it and the button comes back.
  await press(page, page.getByRole("button", { name: "Clock out" }), page.getByRole("button", { name: "Clock in" }));
  const [ended] = await db
    .select({ endedAt: schema.timeEntries.endedAt })
    .from(schema.timeEntries)
    .where(eq(schema.timeEntries.id, running!.id));
  expect(ended?.endedAt).not.toBeNull();
});

test("the health page renders the organisation line and the member table", async ({ page }) => {
  test.setTimeout(180_000);

  await signIn(page);
  await follow(page, page.getByRole("navigation").getByRole("link", { name: "Health" }), "Health");
  // Either a first-response figure against the target or the "nothing to
  // measure yet" note — one of the two is always there.
  await expect(page.getByRole("alert").or(page.getByRole("note")).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "By member" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: ownerName })).toBeVisible();
});

test("the briefs page renders with the manual button", async ({ page }) => {
  test.setTimeout(180_000);

  await signIn(page);
  await follow(page, page.getByRole("navigation").getByRole("link", { name: "Briefs" }), "Briefs");
  await expect(page.getByRole("heading", { name: "Latest" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  // Not pressed: it queues a real, billed agent run in the worker.
  await expect(page.getByRole("button", { name: "Write today's brief" }).first()).toBeVisible();
});

test("a staff member without the content permission has no Content link and is refused by the action", async ({
  page,
}) => {
  test.setTimeout(300_000);

  await signInAs(page, STAFF_EMAIL, staffPassword);

  const nav = page.getByRole("navigation");
  // The rest of the rail is intact; only the area they lack is gone.
  await expect(nav.getByRole("link", { name: "Tasks" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Inbox" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Content" })).toHaveCount(0);
  // Staff default: no Settings either, so Team and the settings screens are hidden too.
  await expect(nav.getByRole("link", { name: "Team", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Timesheets" })).toBeVisible();

  // A typed URL still renders the screen; the action behind it is the guard.
  await page.goto("/content");
  await expect(page.getByRole("heading", { name: "Content" })).toBeVisible({ timeout: COLD_COMPILE });
  const planner = page.getByRole("form", { name: "Plan a month" });
  await planner.getByLabel("Client").selectOption({ index: 1 });
  await press(
    page,
    planner.getByRole("button", { name: "Plan this month" }),
    page.getByText("You do not have the content permission"),
  );
});
