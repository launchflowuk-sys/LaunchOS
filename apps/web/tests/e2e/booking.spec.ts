import { createClient, createLead } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * The client workflow's web half: a stranger books a discovery call on
 * `/book` (mock Zoom unless the keys are set), lands on `/book/done` with the
 * join link, can open their move-or-cancel page and fetch the calendar
 * file; the owner sees the call on `/meetings` and records the outcome. Then
 * the Leads page's Campaign column for a lead created with attribution, and
 * the client details editor renaming a throwaway client.
 *
 * Everything it makes is removed in `afterAll`: the meeting, the lead the
 * booking minted (its conversation and messages cascade), the attributed
 * lead, the throwaway client, and the audit/activity/notification rows.
 */
const COLD_COMPILE = 120_000;
const db = createDb(DATABASE_URL);
const STAMP = Date.now();
const GUEST_NAME = `Booking Guest ${STAMP}`;
const GUEST_EMAIL = `guest.${STAMP}@booking.example`;
const CAMPAIGN = `e2e-spring-${STAMP}`;
const LEAD_EMAIL = `campaign.${STAMP}@booking.example`;
const CLIENT_NAME = `E2E Rename Me ${STAMP}`;
const CLIENT_RENAMED = `E2E Renamed ${STAMP}`;

let organisationId: string;
let attributedLeadId: string;
let clientId: string;
let manageToken: string | null = null;

test.beforeAll(async () => {
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  const lead = await createLead(db, organisationId, {
    name: `Campaign Lead ${STAMP}`,
    email: LEAD_EMAIL,
    business: `Spring Salon ${STAMP}`,
    source: "website",
    attribution: { utmSource: "google", utmMedium: "cpc", utmCampaign: CAMPAIGN, landingPath: "/pricing" },
    notifyOwner: false,
    acknowledge: false,
    actorKind: "system",
  });
  attributedLeadId = lead.id;

  const client = await createClient(db, organisationId, { name: CLIENT_NAME, actorKind: "system" });
  clientId = client.id;
});

test.afterAll(async () => {
  if (!organisationId) return;
  const meetings = await db.select({ id: schema.meetings.id, leadId: schema.meetings.leadId }).from(schema.meetings).where(eq(schema.meetings.guestEmail, GUEST_EMAIL));
  if (meetings.length > 0) await db.delete(schema.meetings).where(inArray(schema.meetings.id, meetings.map((m) => m.id)));
  await db.delete(schema.leads).where(and(eq(schema.leads.organisationId, organisationId), or(eq(schema.leads.email, GUEST_EMAIL), eq(schema.leads.email, LEAD_EMAIL))));
  if (clientId) await db.delete(schema.clients).where(eq(schema.clients.id, clientId));
  const targets = [attributedLeadId, clientId, ...meetings.map((m) => m.id), ...meetings.map((m) => m.leadId)].filter((id): id is string => Boolean(id));
  if (targets.length > 0) await db.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, targets));
  const marker = `%${STAMP}%`;
  await db.delete(schema.activityEvents).where(like(schema.activityEvents.title, marker));
  await db.delete(schema.notifications).where(or(like(schema.notifications.title, marker), like(schema.notifications.body, marker)));
});

test("a stranger books a call on /book, lands on /book/done with the join link, and can open the manage page and the calendar file", async ({ page, request }) => {
  test.setTimeout(300_000);

  await page.goto("/book");
  await expect(page.getByRole("heading", { level: 1, name: "Book a call" })).toBeVisible({ timeout: COLD_COMPILE });
  // The site's own footer, not the app's "Powered by LaunchFlow" strip. The
  // M2 redesign gave /book and /signup the full marketing shell so a visitor
  // arriving from an email sees the same header and footer as the site, and on
  // LaunchFlow's own pages the credit that belongs there is the copyright.
  // "Powered by LaunchFlow" is what a *client's* app carries.
  await expect(page.getByText(`© ${new Date().getFullYear()} LaunchFlow`)).toBeVisible();

  // The strip: at least one open day, and a time under it in the browser's zone.
  const days = page.getByRole("listbox", { name: "Day" }).getByRole("option");
  await expect(days.first()).toBeVisible();
  const times = page.getByRole("listbox", { name: "Time" }).getByRole("option");
  await expect(times.first()).toBeVisible();
  await expect(times.first()).toHaveText(/^\d\d:\d\d$/);

  // Until a time is chosen the button says so and cannot submit.
  await expect(page.getByRole("button", { name: "Pick a time first" })).toBeDisabled();
  await times.first().click();
  await expect(page.getByText(/’s time: \d\d:\d\d/)).toBeVisible();

  await page.getByLabel("Your name").fill(GUEST_NAME);
  await page.getByLabel("Email").fill(GUEST_EMAIL);
  await page.getByLabel(/Anything we should know/).fill(`Booked by the e2e run ${STAMP}.`);
  await page.getByRole("button", { name: "Confirm the call" }).click();

  await page.waitForURL(/\/book\/done\?m=/, { timeout: COLD_COMPILE });
  await expect(page.getByRole("heading", { level: 1, name: "You're booked" })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByText("Call confirmed")).toBeVisible();
  await expect(page.getByText(GUEST_EMAIL)).toBeVisible();
  const join = page.getByRole("link", { name: "Join the call" });
  await expect(join).toHaveAttribute("href", /^https:\/\//);
  await expect(page.getByRole("link", { name: "Add to calendar" })).toHaveAttribute("href", /\/book\/r\/[^/]+\/calendar\.ics$/);

  const manageHref = await page.getByRole("link", { name: "Move or cancel the call" }).getAttribute("href");
  expect(manageHref).toMatch(/^\/book\/r\/[^/?]+$/);
  manageToken = manageHref!.split("/").at(-1)!;

  // The row core wrote: filed under a minted lead, on the mock provider unless Zoom keys are set.
  const [meeting] = await db.select().from(schema.meetings).where(eq(schema.meetings.rescheduleToken, manageToken));
  expect(meeting).toBeDefined();
  expect(meeting!.guestName).toBe(GUEST_NAME);
  expect(meeting!.status).toBe("scheduled");
  expect(meeting!.leadId).not.toBeNull();
  expect(meeting!.metadata).toMatchObject({ source: "public" });

  // The guest's own page, by token, with the same join link and both forms.
  await page.goto(manageHref!);
  await expect(page.getByRole("heading", { level: 1, name: "Your call with LaunchFlow" })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("form", { name: "Move the call" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Cancel the call" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Join the call" })).toHaveAttribute("href", meeting!.joinUrl);
  await expect(page.getByText(GUEST_NAME)).toBeVisible();

  // The calendar file, cookie-less.
  const ics = await request.get(`${manageHref}/calendar.ics`, { timeout: COLD_COMPILE });
  expect(ics.status()).toBe(200);
  expect(ics.headers()["content-type"]).toBe("text/calendar; charset=utf-8; method=REQUEST");
  expect(ics.headers()["content-disposition"]).toMatch(/^attachment; filename=".+\.ics"$/);
  const body = await ics.text();
  expect(body).toContain("BEGIN:VEVENT");
  expect(body).toContain(`UID:${meeting!.id}@launchos`);

  // A wrong token earns nothing.
  expect((await request.get("/book/r/not-a-real-token-at-all-0000/calendar.ics")).status()).toBe(404);
  await page.goto("/book/r/not-a-real-token-at-all-0000");
  await expect(page.getByText("We could not find that booking")).toBeVisible({ timeout: COLD_COMPILE });
});

test("the owner sees the call on /meetings, opens it, and records the outcome", async ({ page }) => {
  test.setTimeout(300_000);
  test.skip(manageToken === null, "the booking test did not run");

  await signIn(page);
  await page.getByRole("navigation").getByRole("link", { name: "Meetings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Meetings" })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("tab", { name: "Upcoming" })).toHaveAttribute("aria-selected", "true");

  const row = page.getByRole("row").filter({ hasText: GUEST_NAME });
  await expect(row).toBeVisible();
  await expect(row.getByText("Scheduled")).toBeVisible();
  await expect(row.getByRole("link", { name: "Join link" })).toHaveAttribute("href", /^https:\/\//);
  // `goto` rather than a click: a first visit to `/meetings/[id]` compiles the
  // route, and `next dev` can answer a soft navigation into a compiling route
  // with a full reload of the page it left (the same cold-compile flake the
  // domains spec notes). A hard navigation is deterministic.
  const openHref = await row.getByRole("link", { name: "Open" }).getAttribute("href");
  expect(openHref).toMatch(/^\/meetings\/[0-9a-f-]{36}$/);
  await page.goto(openHref!);

  await expect(page.getByRole("heading", { level: 1, name: `Discovery call with ${GUEST_NAME}` })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByText("Booking page")).toBeVisible();
  // `exact`: the owner's `meeting.booked` bell quotes the notes too.
  await expect(page.getByText(`Booked by the e2e run ${STAMP}.`, { exact: true })).toBeVisible();

  const outcome = page.getByRole("form", { name: "Mark outcome" });
  await outcome.getByLabel("How did it go?").selectOption("completed");
  await outcome.getByLabel("Notes").fill(`Went well (${STAMP}).`);
  await outcome.getByRole("button", { name: "Save outcome" }).click();
  await expect(page.getByText("Outcome recorded")).toBeVisible();
  await expect(page.getByText("Nothing more to do here.")).toBeVisible();

  const [meeting] = await db.select().from(schema.meetings).where(eq(schema.meetings.rescheduleToken, manageToken!));
  expect(meeting!.status).toBe("completed");
  expect(meeting!.notes).toContain(`Went well (${STAMP}).`);

  // Past now, not upcoming.
  await page.goto("/meetings?scope=past");
  await expect(page.getByRole("row").filter({ hasText: GUEST_NAME }).getByText("Completed")).toBeVisible({ timeout: COLD_COMPILE });
});

test("the Leads page shows the Campaign column and the thirty-day strip for a lead created with attribution", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  await page.goto("/leads");
  await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible({ timeout: COLD_COMPILE });
  const strip = page.getByRole("list", { name: "Leads by campaign" });
  await expect(strip.getByRole("link", { name: new RegExp(CAMPAIGN) })).toBeVisible();

  await strip.getByRole("link", { name: new RegExp(CAMPAIGN) }).click();
  await expect(page).toHaveURL(new RegExp(`campaign=${CAMPAIGN}`));
  const row = page.getByRole("row").filter({ hasText: `Spring Salon ${STAMP}` });
  await expect(row).toBeVisible();
  await expect(row.getByRole("link", { name: CAMPAIGN })).toBeVisible();
  await expect(row.getByText("google / cpc")).toBeVisible();

  await row.getByRole("link", { name: `Spring Salon ${STAMP}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Spring Salon ${STAMP}` })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByText(`google / cpc / ${CAMPAIGN}`)).toBeVisible();
  await expect(page.getByText("landed on /pricing")).toBeVisible();
  await expect(page.getByRole("link", { name: /\/book\?lead=/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Meetings" })).toBeVisible();
});

test("the client details editor saves a new name", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  await page.goto(`/clients/${clientId}`);
  await expect(page.getByRole("heading", { level: 1, name: CLIENT_NAME })).toBeVisible({ timeout: COLD_COMPILE });
  const form = page.getByRole("form", { name: "Client details" });
  await form.getByLabel("Client name").fill(CLIENT_RENAMED);
  await form.getByLabel("Trading name").fill(`Trading ${STAMP}`);
  await form.getByLabel("Industry").fill("Salon");
  await form.getByLabel("Website").fill("https://example.test");
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Client details saved")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: CLIENT_RENAMED })).toBeVisible();

  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
  expect(client).toMatchObject({ name: CLIENT_RENAMED, tradingName: `Trading ${STAMP}`, industry: "Salon", websiteUrl: "https://example.test" });

  // Clearing a field clears the column, and the audit row names the change.
  await form.getByLabel("Trading name").fill("");
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Client details saved")).toBeVisible();
  await expect.poll(async () => (await db.select({ t: schema.clients.tradingName }).from(schema.clients).where(eq(schema.clients.id, clientId)))[0]?.t).toBeNull();
  const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.targetId, clientId), eq(schema.auditLog.action, "client.updated")));
  expect(audits.length).toBeGreaterThanOrEqual(2);
});
