import { createDb, schema } from "@launchos/db";
import { expect, test, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { CLIENT, DATABASE_URL, INBOUND_SECRET, OWNER, SUPPORT_ADDRESS } from "./seed-credentials";

/**
 * Plan 4 §7 acceptance: an email arrives at a client's support address, becomes
 * a case, a human replies from the Inbox and the reply is actually sent; a
 * parked agent reply is approved and the run resumes; and the client sees only
 * their own thread and can answer on it.
 *
 * **This spec needs the worker running with the fake model:**
 *
 * ```bash
 * LLM=fake pnpm dev:worker
 * ```
 *
 * The webhook does no business writes at all — it normalises, stores
 * attachments and enqueues — so without a worker consuming `inbound.message`
 * nothing is ever created, and without one consuming `outbound.message` a reply
 * stays `queued` forever. `LLM=fake` is what makes the second test
 * deterministic: the worker's scripted client always answers a Support Triage
 * run with a `messages_reply_to_client` call, so an approval is always parked
 * and no API key is involved. Every wait fails with a message saying which of
 * those two is missing rather than timing out anonymously.
 *
 * It also needs `pnpm db:seed`: the support address it posts to, and the portal
 * login it signs in as, are both seed rows. Their addresses and passwords come
 * from `./seed-credentials`, which is the only place those literals live.
 */

// The dev server compiles each route the first time it is asked for, measured
// at up to 35s cold, so every first assertion on a screen needs far more than
// the 5s default.
const COLD_COMPILE = 120_000;
// Two round trips through pg-boss: the web process sends, the worker polls.
const WORKER_ROUND_TRIP = 60_000;

const db = createDb(DATABASE_URL);

const stamp = Date.now();
const subject = `Site slow ${stamp}`;
const messageId = `<e2e-${stamp}@grayscabline.co.uk>`;
const staffReply = `Thanks — we are looking at it now (${stamp}).`;
const clientReply = `Thank you, that is helpful (${stamp}).`;

let organisationId = "";
/** Filled in once the worker has ingested; used by the teardown. */
let conversationId = "";
let ticketId = "";
/** The approval the agent parked, so the teardown does not leave it pending. */
let approvalId = "";

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The ingested message, or null while the worker has not got to it yet. */
async function ingestedMessage() {
  const [row] = await db
    .select({ id: schema.messages.id, conversationId: schema.messages.conversationId })
    .from(schema.messages)
    .where(and(eq(schema.messages.organisationId, organisationId), eq(schema.messages.externalId, messageId)));
  return row ?? null;
}

test.beforeAll(async () => {
  const [organisation] = await db
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  const [identity] = await db
    .select({ address: schema.emailIdentities.address })
    .from(schema.emailIdentities)
    .where(
      and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.address, SUPPORT_ADDRESS)),
    );
  if (!identity) {
    throw new Error(
      `no email identity for ${SUPPORT_ADDRESS} — run \`pnpm db:seed\` (and check SUPPORT_EMAIL_DOMAIN matches)`,
    );
  }

  // Checked here so a credential that has drifted from the seed fails in a
  // second with a readable message, rather than as a two-minute navigation
  // timeout inside the third test.
  const [portalUser] = await db
    .select({ id: schema.clientUsers.id })
    .from(schema.clientUsers)
    .innerJoin(schema.user, eq(schema.user.id, schema.clientUsers.userId))
    .where(and(eq(schema.clientUsers.organisationId, organisationId), eq(schema.user.email, CLIENT.email)));
  if (!portalUser) {
    throw new Error(
      `no portal user for ${CLIENT.email} — run \`pnpm db:seed\`, or set SEED_CLIENT_EMAIL to the address it created`,
    );
  }
});

test.afterAll(async () => {
  // The approval first: leaving it behind would put a stale card on /approvals
  // for every later run of the suite.
  if (approvalId) await db.delete(schema.approvals).where(eq(schema.approvals.id, approvalId));
  // tickets next: ticket_events cascade from the ticket, messages from the
  // conversation, and tickets.conversation_id points at the conversation.
  if (ticketId) await db.delete(schema.tickets).where(eq(schema.tickets.id, ticketId));
  if (conversationId) await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
  // Playwright's worker otherwise holds the pool open after the suite.
  await db.$client.end();
});

/** Every worker-dependent wait says the same thing when it times out. */
function workerHint(what: string): string {
  return `${what} — start \`pnpm dev:worker\` with LLM=fake (see README, Quick start)`;
}

interface ParkedReply {
  id: string;
  body: string;
}

/**
 * The pending `messages_reply_to_client` approval on this run's own
 * conversation, or null while the worker has not parked one yet. Narrowed to
 * this conversation so the spec can never approve — and therefore send —
 * somebody else's parked action.
 */
async function parkedReply(): Promise<ParkedReply | null> {
  const rows = await db
    .select({ id: schema.approvals.id, payload: schema.approvals.payload })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.organisationId, organisationId), eq(schema.approvals.status, "pending")));
  for (const row of rows) {
    const payload = row.payload as { toolName?: string; input?: { conversationId?: string; body?: string } } | null;
    if (payload?.toolName !== "messages_reply_to_client") continue;
    if (payload.input?.conversationId !== conversationId) continue;
    const body = payload.input.body;
    if (typeof body !== "string" || body.length === 0) continue;
    return { id: row.id, body };
  }
  return null;
}

/**
 * Polled rather than skipped: with `LLM=fake` the worker always parks a reply
 * for a new ticket, so its absence is a real failure — a stopped worker, a
 * disabled agent or a broken dispatch — and must be reported as one.
 */
async function waitForParkedReply(): Promise<ParkedReply> {
  const message = workerHint("Support Triage never parked a reply for this thread");
  await expect.poll(async () => (await parkedReply()) !== null, { timeout: WORKER_ROUND_TRIP, message }).toBe(true);
  const reply = await parkedReply();
  if (!reply) throw new Error(message);
  return reply;
}

test.describe.serial("P4 support intake", () => {
  test("an inbound email becomes a case, and a staff reply is sent", async ({ page, request }) => {
    test.setTimeout(300_000);

    const response = await request.post("/api/webhooks/email/inbound?provider=generic", {
      headers: { "x-launchos-inbound-secret": INBOUND_SECRET },
      data: {
        to: [SUPPORT_ADDRESS],
        from: "jo@grayscabline.co.uk",
        subject,
        text: "Every page takes about twenty seconds to load since yesterday.",
        messageId,
      },
    });
    expect(response.status(), await response.text()).toBe(202);

    // The webhook only enqueues, so the row appears when the worker gets to it.
    await expect
      .poll(async () => (await ingestedMessage()) !== null, {
        timeout: WORKER_ROUND_TRIP,
        message: workerHint("the inbound email was never ingested"),
      })
      .toBe(true);
    conversationId = (await ingestedMessage())!.conversationId;

    const [conversation] = await db
      .select({ ticketId: schema.conversations.ticketId })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId));
    expect(conversation?.ticketId, "the ingest must open a case for the thread").toBeTruthy();
    ticketId = conversation!.ticketId!;

    await signIn(page, OWNER.email, OWNER.password);
    await page.waitForURL("/", { timeout: COLD_COMPILE });

    // It is a case, not just a mail: it is on the Open Cases list.
    await page.goto("/cases");
    await expect(page.getByRole("link", { name: subject })).toBeVisible({ timeout: COLD_COMPILE });

    // And on the unified inbox.
    await page.goto("/inbox");
    await expect(page.getByRole("link", { name: subject })).toBeVisible({ timeout: COLD_COMPILE });
    await page.getByRole("link", { name: subject }).click();
    await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText("Every page takes about twenty seconds to load since yesterday.")).toBeVisible();

    // A human reply from the inbox needs no approval: it is queued straight away.
    const replyForm = page.getByRole("form", { name: "Reply" });
    await replyForm.locator('textarea[name="body"]').fill(staffReply);
    await replyForm.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByText(staffReply)).toBeVisible({ timeout: 30_000 });

    // …and the worker's outbound job actually sends it. With EMAIL_ADAPTER=mock
    // the send is recorded rather than delivered, but the status transition is
    // the same one a real SMTP send makes.
    await expect
      .poll(
        async () => {
          const [sent] = await db
            .select({ status: schema.messages.status })
            .from(schema.messages)
            .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.body, staffReply)));
          return sent?.status ?? null;
        },
        {
          timeout: WORKER_ROUND_TRIP,
          message: workerHint("the staff reply never left the queue"),
        },
      )
      .toBe("sent");

    await page.reload();
    await expect(page.getByText("sent", { exact: true })).toBeVisible({ timeout: COLD_COMPILE });
  });

  test("a parked agent reply is approved, the run resumes and the reply is sent", async ({ page }) => {
    test.setTimeout(300_000);

    // `ticket.created` from the first test dispatched a Support Triage run. The
    // worker's fake model always answers it with a messages_reply_to_client
    // call, and that tool is `requires_approval`, so an approval for *this*
    // thread is always parked — no API key, no model choice, nothing to skip.
    // Narrowed to this run's own conversation so the spec can never approve —
    // and therefore send — somebody else's parked action.
    const parked = await waitForParkedReply();

    approvalId = parked.id;
    const draftedReply = parked.body;

    await signIn(page, OWNER.email, OWNER.password);
    await page.waitForURL("/", { timeout: COLD_COMPILE });
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible({ timeout: COLD_COMPILE });

    // By id, not by title: `messages_reply_to_client` generates the same title
    // for every parked reply on a thread, and a decided card stays on the page
    // under "Already decided".
    const card = page.locator(`li[data-approval-id="${approvalId}"]`);
    await expect(card).toHaveCount(1, { timeout: COLD_COMPILE });
    await card.getByRole("form", { name: "Approve approval" }).getByRole("button", { name: "Approve" }).click();

    // The web app queues `agent.resume`; the worker runs the tool and stamps
    // the row, so the approval leaves the pending list on its own.
    await expect
      .poll(
        async () => {
          const [row] = await db
            .select({ status: schema.approvals.status })
            .from(schema.approvals)
            .where(eq(schema.approvals.id, approvalId));
          return row?.status ?? null;
        },
        { timeout: WORKER_ROUND_TRIP, message: workerHint("the approval was never decided") },
      )
      .toBe("approved");

    // The acceptance is not the stamped row: it is that approving actually did
    // the outward work. `resumeAgent` executes the tool, which queues the
    // agent's drafted reply, and the worker's outbound job sends it through the
    // configured adapter (mock in development).
    await expect
      .poll(
        async () => {
          const [sent] = await db
            .select({ status: schema.messages.status })
            .from(schema.messages)
            .where(
              and(
                eq(schema.messages.conversationId, conversationId),
                eq(schema.messages.body, draftedReply),
                eq(schema.messages.authorKind, "agent"),
              ),
            );
          return sent?.status ?? null;
        },
        {
          timeout: WORKER_ROUND_TRIP,
          message: workerHint("the approved reply was never sent"),
        },
      )
      .toBe("sent");

    // And the decided card records the outcome rather than still asking.
    await page.reload();
    await expect(page.locator(`li[data-approval-id="${approvalId}"]`)).toContainText("approved", {
      timeout: COLD_COMPILE,
    });
  });

  test("a client user sees only their own case and can reply", async ({ page }) => {
    // Four portal routes, each compiled on its first request.
    test.setTimeout(600_000);

    await signIn(page, CLIENT.email, CLIENT.password);
    await page.waitForURL("/portal", { timeout: COLD_COMPILE });
    await expect(page.getByText("Grays CabLine").first()).toBeVisible({ timeout: COLD_COMPILE });

    await page.goto("/portal/support");
    await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible({ timeout: COLD_COMPILE });

    // The case the email opened belongs to this client, so it is on their list.
    await expect(page.getByRole("link", { name: subject })).toBeVisible();
    // Navigated explicitly rather than clicked: the thread route compiles cold
    // on its first request, which outlasts Playwright's 30s default navigation
    // timeout on a loaded machine and fails as "navigation never finished".
    await page.goto(`/portal/support/${ticketId}`, { timeout: COLD_COMPILE, waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible({ timeout: COLD_COMPILE });

    await page.getByLabel("Add a reply").fill(clientReply);
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByText(clientReply)).toBeVisible({ timeout: COLD_COMPILE });

    // The admin surfaces are not reachable from a portal session: /cases
    // bounces back to the portal, and the admin shell is never rendered.
    // (The portal home does show this case's subject on its "latest
    // conversation" card — it is their own case — so the proof that this is
    // the portal and not Open Cases is the URL and the missing admin nav.)
    await page.goto("/cases", { timeout: COLD_COMPILE, waitUntil: "domcontentloaded" });
    await page.waitForURL("/portal", { timeout: COLD_COMPILE });
    await expect(page.getByRole("navigation").getByRole("link", { name: "Open Cases" })).toHaveCount(0);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Approvals" })).toHaveCount(0);
  });
});
