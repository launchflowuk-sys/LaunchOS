import { createClientUser, createTicket, replyToConversation, updateTicket } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { signIn } from "./sign-in";

/**
 * Plan 4 Task 13 acceptance for the client portal.
 *
 * The seed does not yet ship a portal account (Task 14 adds one), and even
 * once it does the test cannot know its one-time password, so this spec makes
 * its own client user for the seeded "Grays CabLine" client with a unique
 * email and removes it again in `afterAll`. Everything else it needs — the
 * organisation, the two clients, their sites and domains — comes from
 * `pnpm db:seed`.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://launchos:launchos@localhost:5432/launchos";

// The dev server compiles each portal route the first time it is requested,
// which was measured at up to 35s on a cold cache, so the first assertion on a
// new screen needs far longer than the 5s default.
const COLD_COMPILE = 120_000;

const db = createDb(DATABASE_URL);

const STAMP = Date.now();
const PORTAL_EMAIL = `portal.${STAMP}@grayscabline.example`;
const PORTAL_NAME = "Portal Tester";
const OWN_TICKET_SUBJECT = `Seeded ticket ${STAMP}`;
const OTHER_TICKET_SUBJECT = `Other client ticket ${STAMP}`;
const INTERNAL_TICKET_SUBJECT = `Internal collections case ${STAMP}`;
const INTERNAL_NOTE = `Internal staff note ${STAMP} — must never reach the portal`;
const STAFF_ANSWER = `We have rerouted the form to the new address (${STAMP}).`;
const NEW_TICKET_SUBJECT = `Portal raised ${STAMP}`;
const NEW_TICKET_BODY = `The contact form stopped emailing us on ${STAMP}.`;
const REPLY_BODY = `Thanks — it started on Tuesday (${STAMP}).`;

let organisationId: string;
let clientId: string;
let otherClientId: string;
let portalUserId: string;
let portalPassword: string;
let ownTicketId: string;
let otherTicketId: string;
let internalTicketId: string;
/** Every conversation this spec created, torn down in `afterAll`. */
const conversationIds: string[] = [];

async function clientByName(name: string) {
  const [row] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, name)));
  if (!row) throw new Error(`seed client "${name}" not found — run \`pnpm db:seed\` first`);
  return row;
}

async function signInAsPortalUser(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(PORTAL_EMAIL);
  await page.getByLabel("Password").fill(portalPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  // /after-sign-in decides between the admin shell and the portal; a client
  // user lands on /portal.
  await page.waitForURL("/portal", { timeout: COLD_COMPILE });
}

test.beforeAll(async () => {
  const [organisation] = await db
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  clientId = (await clientByName("Grays CabLine")).id;
  otherClientId = (await clientByName("Mobile PC Doctor")).id;

  const created = await createClientUser(db, organisationId, {
    clientId,
    email: PORTAL_EMAIL,
    name: PORTAL_NAME,
  });
  portalUserId = created.user.id;
  portalPassword = created.oneTimePassword;

  // Client-originated, so it is `client_visible` and belongs in their portal.
  const own = await createTicket(db, organisationId, {
    clientId,
    subject: OWN_TICKET_SUBJECT,
    body: "Raised before the portal user signed in.",
    severity: "medium",
    source: "portal",
    actorKind: "client",
    actorId: "e2e-client",
  });
  ownTicketId = own.ticket.id;
  conversationIds.push(own.conversation.id);

  // A staff-authored internal note on the client's own thread. The portal must
  // render the thread without it.
  await replyToConversation(db, organisationId, {
    conversationId: own.conversation.id,
    body: INTERNAL_NOTE,
    actorKind: "user",
    actorId: "staff-e2e",
    internal: true,
  });

  // And a real answer to the client on the same portal thread. There is no
  // participant email on a portal conversation, so this is delivered by the
  // portal itself — the half of the loop that did not exist before.
  await replyToConversation(db, organisationId, {
    conversationId: own.conversation.id,
    body: STAFF_ANSWER,
    actorKind: "user",
    actorId: "staff-e2e",
  });

  // Raised by us, about them: the overdue sweep and the agents' `tickets_create`
  // both look like this. It is the client's own ticket by `client_id` and must
  // still never appear in their portal.
  const internal = await createTicket(db, organisationId, {
    clientId,
    subject: INTERNAL_TICKET_SUBJECT,
    body: "Chase Grays CabLine and record the payment once it lands.",
    severity: "high",
    source: "monitor",
    actorKind: "system",
  });
  internalTicketId = internal.ticket.id;
  conversationIds.push(internal.conversation.id);

  // Client-visible too, so the only thing keeping it out of this portal is the
  // tenancy scope rather than the visibility filter.
  const other = await createTicket(db, organisationId, {
    clientId: otherClientId,
    subject: OTHER_TICKET_SUBJECT,
    body: "Belongs to a different client entirely.",
    severity: "medium",
    source: "portal",
    actorKind: "client",
    actorId: "e2e-other-client",
  });
  otherTicketId = other.ticket.id;
  conversationIds.push(other.conversation.id);
});

test.afterAll(async () => {
  // Tickets cascade their events; conversations cascade their messages. The
  // ticket rows go first because `conversations.ticket_id` has no FK to lean on.
  for (const ticketId of [ownTicketId, internalTicketId, otherTicketId]) {
    if (ticketId) await db.delete(schema.tickets).where(eq(schema.tickets.id, ticketId));
  }
  for (const conversationId of conversationIds) {
    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
  }
  if (portalUserId) {
    // client_users and account cascade from user.
    await db.delete(schema.user).where(eq(schema.user.id, portalUserId));
  }
});

test.describe("client portal", () => {
  test("a client user signs in, sees only their own support, raises a ticket and replies", async ({ page }) => {
    test.setTimeout(300_000);

    await signInAsPortalUser(page);
    await expect(page.getByText("Grays CabLine").first()).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText("Powered by LaunchFlow")).toBeVisible();

    // The admin shell is not reachable from a portal session: it bounces back.
    await page.goto("/tasks");
    await page.waitForURL("/portal", { timeout: COLD_COMPILE });

    await page.getByRole("navigation").getByRole("link", { name: "Support" }).click();
    await expect(page.getByRole("heading", { name: "Support" })).toBeVisible({ timeout: COLD_COMPILE });

    // Their own ticket is listed; the other client's is not.
    await expect(page.getByRole("link", { name: OWN_TICKET_SUBJECT })).toBeVisible();
    await expect(page.getByText(OTHER_TICKET_SUBJECT)).toHaveCount(0);
    // Their own client's internal case is not theirs to read either.
    await expect(page.getByText(INTERNAL_TICKET_SUBJECT)).toHaveCount(0);

    // The internal staff note never reaches the portal thread.
    await page.getByRole("link", { name: OWN_TICKET_SUBJECT }).click();
    await expect(page.getByRole("heading", { name: OWN_TICKET_SUBJECT })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText(INTERNAL_NOTE)).toHaveCount(0);
    // The staff answer does, which is the point of the thread existing.
    await expect(page.getByText(STAFF_ANSWER)).toBeVisible();
    // The courtesy email that tells them to sign in is a record of an email,
    // not a message on the thread they are already reading.
    await expect(page.getByText("Sign in to the portal to read it")).toHaveCount(0);

    // Raise a ticket from the portal.
    await page.getByRole("navigation").getByRole("link", { name: "Support" }).click();
    await page.getByRole("link", { name: "New request" }).click();
    await expect(page.getByRole("heading", { name: "New request" })).toBeVisible({ timeout: COLD_COMPILE });
    await page.getByLabel("Subject").fill(NEW_TICKET_SUBJECT);
    await page.getByLabel("Severity").selectOption("high");
    await page.getByLabel("What has happened?").fill(NEW_TICKET_BODY);
    await page.getByRole("button", { name: "Raise request" }).click();

    // The action redirects to the new thread, which shows the opening message.
    await expect(page.getByRole("heading", { name: NEW_TICKET_SUBJECT })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText(NEW_TICKET_BODY)).toBeVisible();

    // Reply on the thread; the reply is visible straight away.
    await page.getByLabel("Add a reply").fill(REPLY_BODY);
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByText(REPLY_BODY)).toBeVisible({ timeout: COLD_COMPILE });

    // A client cannot self-declare a critical severity.
    await page.goto("/portal/support/new");
    await expect(page.getByLabel("Severity").getByRole("option", { name: "critical" })).toHaveCount(0);
  });

  test("another client's ticket id in the URL is a 404, not somebody else's thread", async ({ page }) => {
    test.setTimeout(180_000);

    await signInAsPortalUser(page);

    const response = await page.goto(`/portal/support/${otherTicketId}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText(OTHER_TICKET_SUBJECT)).toHaveCount(0);
  });

  test("an internal ticket for this client is not listed and 404s on its detail URL", async ({ page }) => {
    test.setTimeout(180_000);

    await signInAsPortalUser(page);

    const response = await page.goto(`/portal/support/${internalTicketId}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText(INTERNAL_TICKET_SUBJECT)).toHaveCount(0);
  });

  test("a client reply reopens a resolved ticket and shows in the thread", async ({ page }) => {
    test.setTimeout(300_000);

    await updateTicket(db, organisationId, { ticketId: ownTicketId, status: "resolved", actorKind: "user" });

    await signInAsPortalUser(page);
    await page.goto(`/portal/support/${ownTicketId}`);
    await expect(page.getByRole("heading", { name: OWN_TICKET_SUBJECT })).toBeVisible({ timeout: COLD_COMPILE });

    const reply = `It is still happening (${STAMP}).`;
    await page.getByLabel("Add a reply").fill(reply);
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByText(reply)).toBeVisible({ timeout: COLD_COMPILE });
    // The box is cleared, so a second click cannot post the same words twice.
    await expect(page.getByLabel("Add a reply")).toHaveValue("");

    const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ownTicketId));
    expect(ticket!.status).toBe("open");
    const [message] = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, ticket!.conversationId!), eq(schema.messages.body, reply)));
    expect(message!.direction).toBe("inbound");
    expect(message!.authorKind).toBe("client");
  });

  test("a staff session is kept out of the portal", async ({ page }) => {
    test.setTimeout(180_000);

    await signIn(page);

    // requireClient checks for a staff session first and bounces to the admin
    // shell rather than rendering the portal against a client_users row that
    // does not exist.
    await page.goto("/portal");
    await page.waitForURL("/", { timeout: COLD_COMPILE });

    // /after-sign-in applies the same precedence.
    await page.goto("/after-sign-in");
    await page.waitForURL("/", { timeout: COLD_COMPILE });
  });

  test("the portal screens are scoped to the signed-in client", async ({ page }) => {
    test.setTimeout(300_000);

    await signInAsPortalUser(page);

    await page.getByRole("navigation").getByRole("link", { name: "Websites" }).click();
    await expect(page.getByRole("heading", { name: "Websites" })).toBeVisible({ timeout: COLD_COMPILE });
    // The row assertions get the same budget as the heading: under load this
    // machine has been observed serving the shell well before the table.
    await expect(page.getByRole("cell", { name: "Grays CabLine" })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText("Mobile PC Doctor")).toHaveCount(0);

    await page.getByRole("navigation").getByRole("link", { name: "Domains" }).click();
    await expect(page.getByRole("heading", { name: "Domains" })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByRole("cell", { name: "grayscabline.co.uk" })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText("mobilepcdoctor.co.uk")).toHaveCount(0);

    await page.getByRole("navigation").getByRole("link", { name: "Progress" }).click();
    await expect(page.getByRole("heading", { name: "Progress" })).toBeVisible({ timeout: COLD_COMPILE });

    await page.getByRole("navigation").getByRole("link", { name: "Account" }).click();
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible({ timeout: COLD_COMPILE });
    // Scoped to the page body: the header carries the same address and its own
    // Sign out button, so an unscoped locator matches twice.
    await expect(page.getByRole("main").getByText(PORTAL_EMAIL)).toBeVisible();
    await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Sign out" })).toBeVisible();
    // …and the shell offers the same way out from every screen.
    await expect(page.getByRole("banner").getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});
