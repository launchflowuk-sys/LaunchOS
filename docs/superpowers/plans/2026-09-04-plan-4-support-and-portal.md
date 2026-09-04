# Plan 4: Support Intake, Client Portal and Support Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn LaunchOS into a support business. Mail to a client's own support address arrives through a webhook, becomes a conversation, a message and a ticket; the Support Triage agent classifies it, searches the knowledge base, assigns it and drafts a reply; the drafted reply parks as an approval; Shoji approves in the admin portal and the run **resumes** and the email is sent through the email adapter. Clients sign in to their own portal and see their sites, domains, tasks and tickets, and reply on the thread.

**Architecture:** `packages/db` migration 0005 adds `email_identities`, `knowledge_articles` and the P4 columns on `conversations`, `messages` and `tickets`. New leaf package `packages/channels` holds the `EmailAdapter` (mock + SMTP), the inbound normalisers and attachment storage. `packages/core` gains inbound ingestion, ticket lifecycle, outbound send, knowledge search and client users. `packages/agents` gains a `runLoop` extraction plus `resumeAgent`, nine P4 tools and the `support-triage` agent. `apps/worker` gains `inbound.message`, `outbound.message` and `agent.resume` queues. `apps/web` gains the inbound webhook, Inbox, Open Cases, Knowledge Base, the resuming Approvals page and the `(portal)` route group.

**Tech Stack:** Node 24, pnpm 11, TypeScript 5 strict, Next.js 16, React 19, Tailwind 4, shadcn/ui, Drizzle ORM + drizzle-kit, `postgres` driver, Better Auth, pg-boss, Zod 4, `@anthropic-ai/sdk`, nodemailer, `react-markdown`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-agency-os-full-build.md` (§1 row P4, §2, §3 P4, §4 Support intake / Support Triage agent / Approval resume / Outbound email / Client portal, §5, §6, §7 P4)

## Global Constraints

From spec §2 (cross-cutting rules):

- Everything in `CLAUDE.md` still binds: tenancy, approval gate, audit log, mock-first integrations, secrets in env, immutability, file size.
- **Ownership assertions.** Any service that takes a foreign id (`clientId`, `siteId`, `ticketId`, `conversationId`, `messageId`, `articleId`…) asserts it belongs to `organisationId` via `assertOwned(db, organisationId, table, id)` in `packages/core/src/tenancy/assert-owned.ts`.
- **Transactions.** Multi-write services run inside `db.transaction`; domain events emit after commit.
- **Domain events.** Extend `DomainEvent` in `packages/core/src/events/emit.ts`. The worker maps events to jobs; `apps/web/src/lib/queue.ts` maps the same events for web-originated writes.
- **Notifications.** Owner is notified in-app via `notifyOwner` for: new ticket, escalation, approval requested, unmatched inbound. Email notification to the owner goes through the outbound email adapter when `OWNER_NOTIFY_EMAIL` is set.
- **Financial details.** Never store card numbers or bank details.
- **UI.** shadcn, white/light, dense but calm tables, left sidebar, page header with primary action, empty states with a call to action, forms validated with Zod on both sides. Mobile-usable. Footer "Powered by LaunchFlow".
- **Client portal scoping.** Every portal query takes `clientId` from the session's `client_users` row. A client user belongs to one client in v1.
- **Tests.** Vitest on every core service with real Postgres (rolled back via `withTestDb`); agent tests with `FakeLlmClient`; Playwright smoke for the P4 flow. Test data uses random slugs and emails.
- **Seed.** Extend the seed; it stays idempotent.

From `CLAUDE.md` (agent rules):

- **Agents never act outward without approval.** Any tool that sends a client message, changes DNS, edits site content or publishes anything is `risk: "requires_approval"`. Internal and mock tools are `risk: "safe"`.
- **Every agent step is recorded.** Tool calls, inputs, outputs, decisions and LLM summaries go to `agent_runs` and `agent_steps`. Every write to a business record by any actor goes to `audit_log`.
- **New agent tool:** `packages/agents/src/tools/<name>.ts` exporting a `ToolDefinition` built with `defineTool`, a Zod input schema and an explicit `risk`. Tool names match `^[a-zA-Z0-9_-]{1,64}$` — underscores, not dots.
- **New agent:** `packages/agents/src/agents/<key>/index.ts` exporting an `AgentDefinition`; register it in `packages/agents/src/agents/index.ts`; enable per organisation in `agent_enablement`.
- **Claude API usage stays inside `AnthropicLlmClient`.** No other file constructs an Anthropic client or calls the API.
- Every core service signature is `(db: Db, organisationId: string, input)`.
- No secrets in code. Env validated with Zod at boot.
- Files 800 lines max; functions under 50 lines.
- Commit after every task with a conventional-commit message.

**Depends on Plans 2 and 3**, which land first and deliver exactly:

- P2 (migration 0003): `clients.slug`, `clients.support_email`, `billing_profiles`, `notifications`, `activity_events`, `domains.client_id`, team columns; `createClient`, `recordActivity(db, organisationId, { clientId?, siteId?, actorKind, actorId?, kind, title, body?, link? })`, `notify` / `notifyOwner(db, organisationId, { kind, title, body?, link? })`, `listMembers(db, organisationId)`, `assertOwned(db, organisationId, table, id)`; a sidebar whose "Inbox", "Open Cases" and "Knowledge Base" items are disabled placeholders; client detail tabs including "Support" and "Portal users" placeholders; `apps/web/src/lib/queue.ts` exporting `enqueue(event: DomainEvent)`.
- P3 (migration 0004): `tasks` and friends; `createTask(db, organisationId, { clientId, siteId?, title, kind, phase, priority?, dueAt?, assigneeUserId?, ticketId?, descriptionMd?, clientVisible? })`, `pickLeastLoadedStaff(db, organisationId): Promise<string | null>`.

**This plan owns migration 0005.**

---

## Resolved spec ambiguities

These are decisions this plan makes where the spec left room. They are load-bearing; do not re-litigate them mid-implementation.

1. **`tickets` assignee column.** Spec §3 P4 says "add `assignee_user_id`", but `tickets.assigned_user_id` already exists from Plan 1 (`packages/db/src/schema/support.ts`). Migration 0005 does **not** add a second column; `assigned_user_id` is the assignee everywhere.
2. **`email_identities` creation.** `createClient` belongs to P2 and is not modified. The worker's `client.created` handler calls `ensureEmailIdentity` alongside P3's onboarding-task generation, and the seed backfills identities for clients created before this plan.
3. **`messages.status` is nullable.** `queued | sent | failed | received` describe email messages only; internal notes leave it null.
4. **`first_response_at`** is stamped when the first outbound message is *queued* (the human or agent has responded), not when the SMTP transport confirms delivery.
5. **SLA.** `sla_due_at = created_at + SLA_HOURS_BY_SEVERITY[severity]` where the map is `{ low: 72, medium: 48, high: 8, critical: 2 }`. Calendar hours, not business hours, in v1.
6. **"Unread" in the Inbox** means the newest message on the conversation is `direction = "inbound"`. No read-receipt column is added.
7. **Open Cases route.** The Plan 1 `/tickets` page becomes `/cases`; `/tickets` is left as a redirect so old links keep working.
8. **Webhook organisation resolution.** The route resolves the organisation from `email_identities.address`; with no match it falls back to the oldest active organisation (the single-tenant v1 rule) and the ingest job files the mail under that organisation's `unmatched` holding client.

---

## File structure for this plan

```
packages/db/src/schema/email.ts                     email_identities
packages/db/src/schema/knowledge.ts                 knowledge_articles + tsvector custom type
packages/db/src/schema/support.ts                   (modified) P4 columns on conversations/messages/tickets
packages/db/drizzle/0005_*.sql                      migration 0005

packages/channels/package.json, tsconfig.json, vitest.config.ts
packages/channels/src/index.ts
packages/channels/src/email/types.ts                EmailAdapter, OutboundEmail, SendResult
packages/channels/src/email/mock.ts                 MockEmailAdapter
packages/channels/src/email/smtp.ts                 SmtpEmailAdapter (nodemailer)
packages/channels/src/email/factory.ts              createEmailAdapter(env)
packages/channels/src/email/inbound.ts              InboundEmail + normalizePostmark/Cloudflare/Generic
packages/channels/src/storage/attachments.ts        storeInboundAttachments under STORAGE_DIR

packages/core/src/email/ensure-email-identity.ts
packages/core/src/support/ingest-inbound-email.ts
packages/core/src/support/reply-to-conversation.ts
packages/core/src/support/send-queued-message.ts
packages/core/src/support/update-ticket.ts
packages/core/src/support/assign-ticket.ts
packages/core/src/support/escalate-ticket.ts
packages/core/src/support/sla.ts
packages/core/src/support/create-ticket.ts          (modified) accepts an existing conversationId
packages/core/src/knowledge/{create,update,delete}-article.ts, search-knowledge.ts
packages/core/src/client-users/create-client-user.ts
packages/core/src/events/emit.ts                    (modified) three new DomainEvent variants

packages/agents/src/kernel/run-loop.ts              extracted loop shared by run + resume
packages/agents/src/kernel/run-agent.ts             (modified) delegates to runLoop
packages/agents/src/kernel/resume-agent.ts          resumeAgent
packages/agents/src/kernel/run-recorder.ts          (modified) RunRecorder.reopen
packages/agents/src/tools/tickets-get.ts, knowledge-search.ts, tickets-update.ts,
  tasks-create.ts, tickets-assign.ts, tickets-escalate.ts,
  messages-reply-to-client.ts, dns-update-record.ts, cms-update-content.ts
packages/agents/src/agents/support-triage/index.ts + support-triage.test.ts
packages/integrations/src/cloudflare/index.ts       DnsProvider + MockCloudflareDns
packages/integrations/src/cms/index.ts              CmsProvider + MockCmsProvider

apps/worker/src/boss.ts                             (modified) three new queues
apps/worker/src/jobs/inbound-message.ts, outbound-message.ts, agent-resume.ts
apps/worker/src/index.ts                            (modified) event → job mappings

apps/web/src/app/api/webhooks/email/inbound/route.ts
apps/web/src/app/api/attachments/[org]/[file]/route.ts
apps/web/src/lib/queue.ts                           (modified) three new mappings
apps/web/src/lib/portal-session.ts                  getClientSession / requireClient
apps/web/src/app/(admin)/inbox/**                   list + thread + reply
apps/web/src/app/(admin)/cases/**                   list + detail + triage panel
apps/web/src/app/(admin)/knowledge/**               CRUD + Markdown editor
apps/web/src/app/(admin)/approvals/actions.ts       (modified) enqueue agent.resume
apps/web/src/app/(admin)/settings/email/**          domain, adapter status, test send
apps/web/src/app/(admin)/clients/[id]/support/page.tsx, portal-users/**
apps/web/src/app/(portal)/**                        portal layout + 8 pages
apps/web/src/app/after-sign-in/page.tsx             routes staff to /, client users to /portal
apps/web/tests/e2e/support-intake.spec.ts
```

---

### Task 1: Migration 0005 — email identities, knowledge articles, P4 support columns

**Files:**
- Create: `packages/db/src/schema/email.ts`, `packages/db/src/schema/knowledge.ts`
- Modify: `packages/db/src/schema/support.ts`, `packages/db/src/schema/index.ts`
- Create: `packages/db/drizzle/0005_<generated>.sql` (via `pnpm db:generate`)
- Test: `packages/db/src/schema/schema.test.ts` (extend)

**Interfaces:**
- Produces: `schema.emailIdentities`, `schema.knowledgeArticles`, `schema.messageStatusEnum`, `tsvector` custom type; new columns `conversations.ticket_id / external_thread_key / participant_email`, `messages.from_email / to_email / subject / raw_headers / attachments / status`, `tickets.first_response_at / resolved_at / sla_due_at / triage`.

- [ ] **Step 1: Failing schema test**

Append to `packages/db/src/schema/schema.test.ts`:
```ts
import { sql } from "drizzle-orm";

describe("plan 4 schema", () => {
  it("stores an email identity, a knowledge article and P4 support columns", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C" }).returning();

      const [identity] = await db.insert(schema.emailIdentities).values({
        organisationId: org!.id, clientId: client!.id, address: `c-${crypto.randomUUID()}@support.test`, inboundSecret: "s",
      }).returning();
      expect(identity!.address).toContain("@support.test");

      const [article] = await db.insert(schema.knowledgeArticles).values({
        organisationId: org!.id, title: "DNS propagation", slug: `dns-${crypto.randomUUID()}`,
        bodyMd: "Nameserver changes take up to 48 hours to propagate.", tags: ["dns"], published: true,
      }).returning();
      const hits = await db.execute(sql`
        select id from knowledge_articles
        where organisation_id = ${org!.id} and search @@ plainto_tsquery('english', 'propagate nameserver')
      `);
      expect(hits.map((r) => r.id)).toContain(article!.id);

      const [conversation] = await db.insert(schema.conversations).values({
        organisationId: org!.id, clientId: client!.id, subject: "Help", channel: "email",
        externalThreadKey: "<a@b.test>", participantEmail: "sender@b.test",
      }).returning();
      const [message] = await db.insert(schema.messages).values({
        organisationId: org!.id, conversationId: conversation!.id, direction: "inbound", authorKind: "client",
        body: "hello", fromEmail: "sender@b.test", toEmail: identity!.address, subject: "Help",
        rawHeaders: { "message-id": "<a@b.test>" }, attachments: [], status: "received",
      }).returning();
      expect(message!.status).toBe("received");

      const [ticket] = await db.insert(schema.tickets).values({
        organisationId: org!.id, conversationId: conversation!.id, clientId: client!.id, subject: "Help",
        source: "email", slaDueAt: new Date(), triage: { category: "dns", severity: "high", summary: "s", suggestedFix: "f", confidence: 0.8 },
      }).returning();
      expect(ticket!.triage).toMatchObject({ category: "dns" });
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @launchos/db test`
Expected: FAIL — `schema.emailIdentities` and `schema.knowledgeArticles` are not exported and the new columns do not exist.

- [ ] **Step 3: New schema files**

`packages/db/src/schema/email.ts`:
```ts
import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

/** One support address per client: `<clients.slug>@<SUPPORT_EMAIL_DOMAIN>`. */
export const emailIdentities = pgTable("email_identities", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  displayName: text("display_name"),
  // Per-identity secret so a provider can be configured to sign one client's
  // forwards without sharing INBOUND_EMAIL_SECRET across every client.
  inboundSecret: text("inbound_secret").notNull(),
}, (t) => [
  uniqueIndex("email_identities_client").on(t.clientId),
  uniqueIndex("email_identities_address").on(t.address),
]);
```

`packages/db/src/schema/knowledge.ts`:
```ts
import { sql } from "drizzle-orm";
import { boolean, customType, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

export const tsvector = customType<{ data: string; driverData: string }>({ dataType: () => "tsvector" });

/**
 * `search` is a stored generated column: every expression in it is IMMUTABLE
 * (`to_tsvector(regconfig, text)` with a literal config, `array_to_string`),
 * which is what Postgres requires of a generated column.
 */
export const knowledgeArticles = pgTable("knowledge_articles", {
  ...tenantColumns(),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  bodyMd: text("body_md").notNull(),
  tags: text("tags").array().$type<string[]>().default([]).notNull(),
  published: boolean("published").default(false).notNull(),
  search: tsvector("search").generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body_md, '')), 'B') || setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'C')`,
  ),
}, (t) => [
  uniqueIndex("knowledge_articles_org_slug").on(t.organisationId, t.slug),
  index("knowledge_articles_search").using("gin", t.search),
]);
```

Add to `packages/db/src/schema/index.ts`:
```ts
export * from "./email.js";
export * from "./knowledge.js";
```

- [ ] **Step 4: P4 columns on support.ts**

In `packages/db/src/schema/support.ts` add the enum and the columns:
```ts
export const messageStatusEnum = pgEnum("message_status", ["queued", "sent", "failed", "received"]);

export interface StoredAttachment { name: string; contentType: string; size: number; url: string }
export interface TicketTriage { category: string; severity: string; summary: string; suggestedFix: string; confidence: number }
```
`conversations` gains:
```ts
  // No FK to tickets: tickets already references conversations, and a second
  // FK the other way is a cycle Drizzle cannot order. Kept in sync by
  // ingestInboundEmail and createTicket, which write both sides in one tx.
  ticketId: uuid("ticket_id"),
  externalThreadKey: text("external_thread_key"),
  participantEmail: text("participant_email"),
```
with a table extra `uniqueIndex("conversations_org_thread_key").on(t.organisationId, t.externalThreadKey)`.

`messages` gains:
```ts
  fromEmail: text("from_email"),
  toEmail: text("to_email"),
  subject: text("subject"),
  rawHeaders: jsonb("raw_headers").$type<Record<string, string>>().default({}).notNull(),
  attachments: jsonb("attachments").$type<StoredAttachment[]>().default([]).notNull(),
  // Null for internal notes: queued/sent/failed/received describe email only.
  status: messageStatusEnum("status"),
```

`tickets` gains:
```ts
  firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
  triage: jsonb("triage").$type<TicketTriage | null>(),
```

- [ ] **Step 5: Generate and review the migration**

Run: `pnpm db:generate`
Review the emitted `packages/db/drizzle/0005_*.sql`. It must contain, in this order:
```sql
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'failed', 'received');
CREATE TABLE "email_identities" ( ... );
CREATE TABLE "knowledge_articles" ( ..., "search" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body_md, '')), 'B') || setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'C')) STORED );
CREATE INDEX "knowledge_articles_search" ON "knowledge_articles" USING gin ("search");
ALTER TABLE "conversations" ADD COLUMN "ticket_id" uuid;
...
```
If drizzle-kit emits the generated column without `STORED`, hand-edit the SQL to add it and leave the schema file unchanged — the snapshot already matches. Do not hand-edit anything else.

- [ ] **Step 6: Migrate and run the test**

Run: `pnpm db:up && pnpm db:migrate && pnpm --filter @launchos/db test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0005 — email identities, knowledge articles, support intake columns"
```

---

### Task 2: `packages/channels` — email adapters, inbound normalisers, attachment storage

**Files:**
- Create: `packages/channels/package.json`, `packages/channels/tsconfig.json`, `packages/channels/vitest.config.ts`, `packages/channels/src/index.ts`
- Create: `packages/channels/src/email/types.ts`, `mock.ts`, `smtp.ts`, `factory.ts`, `inbound.ts`
- Create: `packages/channels/src/storage/attachments.ts`
- Test: `packages/channels/src/email/inbound.test.ts`, `packages/channels/src/email/mock.test.ts`, `packages/channels/src/storage/attachments.test.ts`

**Interfaces:**
- Produces:
  - `EmailAdapter { readonly name: "mock" | "smtp"; send(msg: OutboundEmail): Promise<SendResult> }`
  - `OutboundEmail = { to, from, replyTo?, subject, text, html?, inReplyTo?, references? }`
  - `SendResult = { providerMessageId: string; acceptedAt: string }`
  - `MockEmailAdapter` with a public `sent: OutboundEmail[]`
  - `SmtpEmailAdapter` (nodemailer)
  - `createEmailAdapter(env: NodeJS.ProcessEnv): EmailAdapter`
  - `InboundEmail`, `NormalisedInbound`, `RawAttachment`, `normalizePostmark`, `normalizeCloudflare`, `normalizeGeneric`, `normalizeInbound(provider, payload)`
  - `storeInboundAttachments(organisationId, raws, env?): Promise<StoredAttachment[]>`

- [ ] **Step 1: Failing tests**

`packages/channels/src/email/inbound.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeCloudflare, normalizeGeneric, normalizeInbound, normalizePostmark } from "./inbound.js";

describe("inbound normalisers", () => {
  it("normalises a Postmark inbound payload", () => {
    const out = normalizePostmark({
      From: "jo@client.test", FromName: "Jo", Subject: "Site is down",
      ToFull: [{ Email: "grays-cabline@support.launchflow.co.uk" }],
      TextBody: "The site shows a 503.", HtmlBody: "<p>The site shows a 503.</p>",
      MessageID: "abc-123",
      Headers: [{ Name: "In-Reply-To", Value: "<root@support.test>" }, { Name: "References", Value: "<root@support.test> <two@support.test>" }],
      Attachments: [{ Name: "screenshot.png", ContentType: "image/png", Content: "aGk=", ContentLength: 2 }],
    });
    expect(out.provider).toBe("postmark");
    expect(out.to).toEqual(["grays-cabline@support.launchflow.co.uk"]);
    expect(out.from).toBe("jo@client.test");
    expect(out.messageId).toBe("<abc-123>");
    expect(out.inReplyTo).toBe("<root@support.test>");
    expect(out.references).toEqual(["<root@support.test>", "<two@support.test>"]);
    expect(out.attachments).toEqual([{ name: "screenshot.png", contentType: "image/png", contentBase64: "aGk=" }]);
  });

  it("normalises a Cloudflare Email Routing forward", () => {
    const out = normalizeCloudflare({
      to: "grays-cabline@support.launchflow.co.uk", from: "jo@client.test", subject: "Hi", text: "Body",
      headers: { "message-id": "<cf-1@mx.test>", "in-reply-to": "<root@support.test>" },
    });
    expect(out.provider).toBe("cloudflare");
    expect(out.messageId).toBe("<cf-1@mx.test>");
    expect(out.inReplyTo).toBe("<root@support.test>");
    expect(out.attachments).toEqual([]);
  });

  it("normalises a generic payload and is reachable through normalizeInbound", () => {
    const payload = { to: ["a@support.test"], from: "b@c.test", subject: "S", text: "T", messageId: "<g-1@c.test>" };
    expect(normalizeGeneric(payload).messageId).toBe("<g-1@c.test>");
    expect(normalizeInbound("generic", payload).from).toBe("b@c.test");
  });

  it("rejects a payload with no recipient", () => {
    expect(() => normalizeGeneric({ to: [], from: "b@c.test", subject: "S", text: "T", messageId: "<x@c.test>" })).toThrow();
  });
});
```

`packages/channels/src/email/mock.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createEmailAdapter } from "./factory.js";
import { MockEmailAdapter } from "./mock.js";

describe("email adapters", () => {
  it("records what the mock adapter was asked to send", async () => {
    const adapter = new MockEmailAdapter();
    const result = await adapter.send({ to: "jo@client.test", from: "support@launchflow.test", subject: "Re: Site", text: "Fixed." });
    expect(result.providerMessageId).toMatch(/^mock-/);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.subject).toBe("Re: Site");
  });

  it("defaults to the mock adapter and selects smtp only when asked", () => {
    expect(createEmailAdapter({}).name).toBe("mock");
    expect(createEmailAdapter({ EMAIL_ADAPTER: "mock", SMTP_HOST: "smtp.test" }).name).toBe("mock");
    expect(createEmailAdapter({ EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "587", MAIL_FROM: "s@t.test" }).name).toBe("smtp");
    expect(() => createEmailAdapter({ EMAIL_ADAPTER: "smtp" })).toThrow(/SMTP_HOST/);
  });
});
```

`packages/channels/src/storage/attachments.test.ts`:
```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storeInboundAttachments } from "./attachments.js";

describe("storeInboundAttachments", () => {
  it("writes each attachment under STORAGE_DIR and returns its metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launchos-"));
    const org = "11111111-1111-1111-1111-111111111111";
    const [stored] = await storeInboundAttachments(org, [{ name: "note.txt", contentType: "text/plain", contentBase64: "aGk=" }], { STORAGE_DIR: dir });
    expect(stored!.size).toBe(2);
    expect(stored!.url).toMatch(new RegExp(`^/api/attachments/${org}/`));
    const file = join(dir, "attachments", org, stored!.url.split("/").pop()!);
    expect(await readFile(file, "utf8")).toBe("hi");
  });

  it("refuses a filename that tries to escape the organisation directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launchos-"));
    const [stored] = await storeInboundAttachments("org", [{ name: "../../etc/passwd", contentType: "text/plain", contentBase64: "aGk=" }], { STORAGE_DIR: dir });
    expect(stored!.name).toBe("passwd");
    expect(stored!.url).not.toContain("..");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @launchos/channels test`
Expected: FAIL — the package does not exist yet.

- [ ] **Step 3: Package scaffolding**

`packages/channels/package.json`:
```json
{
  "name": "@launchos/channels",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "dependencies": { "nodemailer": "^7.0.9", "zod": "^4.4.3" },
  "devDependencies": { "@launchos/config": "workspace:*", "@types/node": "^24", "@types/nodemailer": "^7", "typescript": "^5", "vitest": "^3" }
}
```
`packages/channels/tsconfig.json`:
```json
{ "extends": "@launchos/config/tsconfig.node.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*.ts"] }
```
`packages/channels/vitest.config.ts`:
```ts
export { sharedVitestConfig as default } from "@launchos/config/vitest.shared";
```
`packages/channels/src/index.ts`:
```ts
export * from "./email/types.js";
export * from "./email/mock.js";
export * from "./email/smtp.js";
export * from "./email/factory.js";
export * from "./email/inbound.js";
export * from "./storage/attachments.js";
```

- [ ] **Step 4: Outbound adapters**

`packages/channels/src/email/types.ts`:
```ts
import { z } from "zod";

export const OutboundEmailSchema = z.object({
  to: z.string().email(),
  from: z.string().min(3),
  replyTo: z.string().email().optional(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
});
export type OutboundEmail = z.infer<typeof OutboundEmailSchema>;

export interface SendResult { providerMessageId: string; acceptedAt: string }

export interface EmailAdapter {
  readonly name: "mock" | "smtp";
  send(msg: OutboundEmail): Promise<SendResult>;
}
```

`packages/channels/src/email/mock.ts`:
```ts
import { randomUUID } from "node:crypto";
import { OutboundEmailSchema, type EmailAdapter, type OutboundEmail, type SendResult } from "./types.js";

/**
 * Records what it was asked to send instead of talking to a mail server.
 * It deliberately does not touch the database: the caller
 * (`sendQueuedMessage`) owns the `messages.status` transition.
 */
export class MockEmailAdapter implements EmailAdapter {
  readonly name = "mock" as const;
  readonly sent: OutboundEmail[] = [];

  async send(msg: OutboundEmail): Promise<SendResult> {
    const parsed = OutboundEmailSchema.parse(msg);
    this.sent.push(parsed);
    return { providerMessageId: `mock-${randomUUID()}`, acceptedAt: new Date().toISOString() };
  }
}
```

`packages/channels/src/email/smtp.ts`:
```ts
import { createTransport, type Transporter } from "nodemailer";
import { OutboundEmailSchema, type EmailAdapter, type OutboundEmail, type SendResult } from "./types.js";

export interface SmtpConfig { host: string; port: number; user?: string; pass?: string; secure: boolean }

export class SmtpEmailAdapter implements EmailAdapter {
  readonly name = "smtp" as const;
  private readonly transport: Transporter;

  constructor(config: SmtpConfig, transport?: Transporter) {
    this.transport =
      transport ??
      createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
      });
  }

  async send(msg: OutboundEmail): Promise<SendResult> {
    const m = OutboundEmailSchema.parse(msg);
    const info = await this.transport.sendMail({
      to: m.to, from: m.from, replyTo: m.replyTo, subject: m.subject, text: m.text, html: m.html,
      inReplyTo: m.inReplyTo, references: m.references,
    });
    return { providerMessageId: info.messageId, acceptedAt: new Date().toISOString() };
  }
}
```

`packages/channels/src/email/factory.ts`:
```ts
import { z } from "zod";
import { MockEmailAdapter } from "./mock.js";
import { SmtpEmailAdapter } from "./smtp.js";
import type { EmailAdapter } from "./types.js";

const SmtpEnv = z.object({
  SMTP_HOST: z.string().min(1, "SMTP_HOST is required when EMAIL_ADAPTER=smtp"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
});

/** Mock unless EMAIL_ADAPTER is explicitly "smtp" — mock-first, per CLAUDE.md rule 4. */
export function createEmailAdapter(env: NodeJS.ProcessEnv): EmailAdapter {
  if (env.EMAIL_ADAPTER !== "smtp") return new MockEmailAdapter();
  const cfg = SmtpEnv.parse(env);
  return new SmtpEmailAdapter({
    host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, user: cfg.SMTP_USER, pass: cfg.SMTP_PASS, secure: cfg.SMTP_PORT === 465,
  });
}
```

- [ ] **Step 5: Inbound normalisers**

`packages/channels/src/email/inbound.ts`:
```ts
import { z } from "zod";

export interface RawAttachment { name: string; contentType: string; contentBase64: string }
export interface StoredAttachment { name: string; contentType: string; size: number; url: string }

export type InboundProvider = "postmark" | "cloudflare" | "generic";

export interface NormalisedInbound {
  provider: InboundProvider;
  to: string[];
  from: string;
  fromName?: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references: string[];
  attachments: RawAttachment[];
  rawHeaders: Record<string, string>;
}

/** What the queue carries: identical, except attachments are already on disk. */
export type InboundEmail = Omit<NormalisedInbound, "attachments"> & { attachments: StoredAttachment[] };

export const InboundEmailSchema = z.object({
  provider: z.enum(["postmark", "cloudflare", "generic"]),
  to: z.array(z.string()).min(1),
  from: z.string().min(3),
  fromName: z.string().optional(),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
  messageId: z.string().min(1),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  attachments: z.array(z.object({ name: z.string(), contentType: z.string(), size: z.number().int().nonnegative(), url: z.string() })),
  rawHeaders: z.record(z.string(), z.string()),
});

/** Message-IDs are compared as strings, so normalise them to `<...>` form once. */
export function angle(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

export function splitReferences(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).map((v) => v.trim()).filter((v) => v.length > 0).map(angle);
}

function ensureRecipient(to: string[]): string[] {
  const cleaned = to.map((t) => t.trim().toLowerCase()).filter((t) => t.includes("@"));
  if (cleaned.length === 0) throw new Error("inbound email has no recipient address");
  return cleaned;
}

const PostmarkPayload = z.object({
  From: z.string(), FromName: z.string().optional(), Subject: z.string().default(""),
  To: z.string().optional(),
  ToFull: z.array(z.object({ Email: z.string() })).optional(),
  TextBody: z.string().default(""), HtmlBody: z.string().optional(),
  MessageID: z.string(),
  Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).default([]),
  Attachments: z.array(z.object({ Name: z.string(), ContentType: z.string(), Content: z.string() })).default([]),
});

export function normalizePostmark(payload: unknown): NormalisedInbound {
  const p = PostmarkPayload.parse(payload);
  const headers = Object.fromEntries(p.Headers.map((h) => [h.Name.toLowerCase(), h.Value]));
  return {
    provider: "postmark",
    to: ensureRecipient(p.ToFull?.map((t) => t.Email) ?? (p.To ? p.To.split(",") : [])),
    from: p.From.trim().toLowerCase(),
    fromName: p.FromName,
    subject: p.Subject,
    text: p.TextBody,
    html: p.HtmlBody,
    messageId: angle(p.MessageID),
    inReplyTo: headers["in-reply-to"] ? angle(headers["in-reply-to"]) : undefined,
    references: splitReferences(headers["references"]),
    attachments: p.Attachments.map((a) => ({ name: a.Name, contentType: a.ContentType, contentBase64: a.Content })),
    rawHeaders: headers,
  };
}

const CloudflarePayload = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  from: z.string(), fromName: z.string().optional(),
  subject: z.string().default(""), text: z.string().default(""), html: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
});

/** Shape posted by the Cloudflare Email Routing worker documented in DEPLOYMENT.md. */
export function normalizeCloudflare(payload: unknown): NormalisedInbound {
  const p = CloudflarePayload.parse(payload);
  const headers = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const messageId = headers["message-id"];
  if (!messageId) throw new Error("cloudflare inbound payload has no Message-ID header");
  return {
    provider: "cloudflare",
    to: ensureRecipient(Array.isArray(p.to) ? p.to : [p.to]),
    from: p.from.trim().toLowerCase(),
    fromName: p.fromName,
    subject: p.subject,
    text: p.text,
    html: p.html,
    messageId: angle(messageId),
    inReplyTo: headers["in-reply-to"] ? angle(headers["in-reply-to"]) : undefined,
    references: splitReferences(headers["references"]),
    attachments: [],
    rawHeaders: headers,
  };
}

const GenericPayload = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  from: z.string(), fromName: z.string().optional(),
  subject: z.string().default(""), text: z.string().default(""), html: z.string().optional(),
  messageId: z.string(), inReplyTo: z.string().optional(),
  references: z.array(z.string()).default([]),
  attachments: z.array(z.object({ name: z.string(), contentType: z.string(), contentBase64: z.string() })).default([]),
  headers: z.record(z.string(), z.string()).default({}),
});

export function normalizeGeneric(payload: unknown): NormalisedInbound {
  const p = GenericPayload.parse(payload);
  return {
    provider: "generic",
    to: ensureRecipient(Array.isArray(p.to) ? p.to : [p.to]),
    from: p.from.trim().toLowerCase(),
    fromName: p.fromName,
    subject: p.subject,
    text: p.text,
    html: p.html,
    messageId: angle(p.messageId),
    inReplyTo: p.inReplyTo ? angle(p.inReplyTo) : undefined,
    references: p.references.map(angle),
    attachments: p.attachments,
    rawHeaders: p.headers,
  };
}

export function normalizeInbound(provider: InboundProvider, payload: unknown): NormalisedInbound {
  if (provider === "postmark") return normalizePostmark(payload);
  if (provider === "cloudflare") return normalizeCloudflare(payload);
  return normalizeGeneric(payload);
}
```

- [ ] **Step 6: Attachment storage**

`packages/channels/src/storage/attachments.ts`:
```ts
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { RawAttachment, StoredAttachment } from "../email/inbound.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function storageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.STORAGE_DIR ?? "./storage";
}

/**
 * `basename` on an attacker-supplied name, then a generated file name on disk:
 * the original is only ever shown as a label, never used as a path segment.
 */
function safeName(name: string): string {
  const base = basename(name.replaceAll("\\", "/")).replaceAll("..", "");
  return base.length > 0 ? base.slice(0, 200) : "attachment";
}

export async function storeInboundAttachments(
  organisationId: string,
  attachments: RawAttachment[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredAttachment[]> {
  if (attachments.length === 0) return [];
  const dir = join(storageRoot(env), "attachments", organisationId);
  await mkdir(dir, { recursive: true });
  const stored: StoredAttachment[] = [];
  for (const raw of attachments) {
    const bytes = Buffer.from(raw.contentBase64, "base64");
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`attachment ${raw.name} exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    const label = safeName(raw.name);
    const file = `${randomUUID()}${extname(label)}`;
    await writeFile(join(dir, file), bytes);
    stored.push({ name: label, contentType: raw.contentType, size: bytes.byteLength, url: `/api/attachments/${organisationId}/${file}` });
  }
  return stored;
}
```

- [ ] **Step 7: Install and run**

Run: `pnpm install && pnpm --filter @launchos/channels test && pnpm --filter @launchos/channels typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(channels): email adapters, inbound normalisers and attachment storage"
```

---

### Task 3: Core — email identities, inbound ingestion, new domain events

**Files:**
- Create: `packages/core/src/email/ensure-email-identity.ts`, `packages/core/src/support/ingest-inbound-email.ts`
- Modify: `packages/core/src/support/create-ticket.ts` (accept an existing conversation), `packages/core/src/events/emit.ts`, `packages/core/src/index.ts`, `packages/core/package.json`
- Test: `packages/core/src/support/ingest-inbound-email.test.ts`

**Interfaces:**
- Produces:
  - `ensureEmailIdentity(db, organisationId, { clientId, displayName? }, env?) → EmailIdentity`
  - `supportAddress(slug, domain) → string`
  - `ingestInboundEmail(db, organisationId, inbound: InboundEmail) → { conversation, message, ticket, matched: boolean }`
  - `HOLDING_CLIENT_SLUG = "unmatched"`
  - `createTicket` gains an optional `conversationId`: when supplied the ticket attaches to that conversation and no new conversation or opening message is created.
  - `DomainEvent` gains `{ name: "email.received"; organisationId; inbound: InboundEmail }`, `{ name: "message.queued"; organisationId; messageId }`, `{ name: "approval.decided"; organisationId; approvalId; runId; decision: "approved" | "rejected"; note?: string }`.

- [ ] **Step 1: Failing test**

`packages/core/src/support/ingest-inbound-email.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import type { InboundEmail } from "@launchos/channels";
import { ensureEmailIdentity } from "../email/ensure-email-identity.js";
import { HOLDING_CLIENT_SLUG, ingestInboundEmail } from "./ingest-inbound-email.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test" };

function inbound(over: Partial<InboundEmail> & Pick<InboundEmail, "to">): InboundEmail {
  return {
    provider: "generic", from: "jo@client.test", subject: "Site is down", text: "It shows a 503.",
    messageId: `<${crypto.randomUUID()}@client.test>`, references: [], attachments: [], rawHeaders: {}, ...over,
  };
}

async function newOrg(db: Db) {
  const [o] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return o!;
}

describe("ingestInboundEmail", () => {
  it("creates a conversation, message and ticket for a known support address", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const [client] = await db.insert(schema.clients).values({ organisationId: o.id, name: "Grays CabLine", slug: "grays-cabline" }).returning();
      const identity = await ensureEmailIdentity(db, o.id, { clientId: client!.id }, ENV);

      const result = await ingestInboundEmail(db, o.id, inbound({ to: [identity.address] }));

      expect(result.matched).toBe(true);
      expect(result.conversation.clientId).toBe(client!.id);
      expect(result.conversation.channel).toBe("email");
      expect(result.conversation.ticketId).toBe(result.ticket.id);
      expect(result.message.direction).toBe("inbound");
      expect(result.message.status).toBe("received");
      expect(result.ticket.source).toBe("email");
      expect(result.ticket.slaDueAt).toBeInstanceOf(Date);
    });
  });

  it("threads a reply onto the existing conversation and reuses its open ticket", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const [client] = await db.insert(schema.clients).values({ organisationId: o.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, o.id, { clientId: client!.id }, ENV);

      const first = await ingestInboundEmail(db, o.id, inbound({ to: [identity.address] }));
      const second = await ingestInboundEmail(db, o.id, inbound({
        to: [identity.address], inReplyTo: first.message.externalId!, references: [first.message.externalId!],
      }));

      expect(second.conversation.id).toBe(first.conversation.id);
      expect(second.ticket.id).toBe(first.ticket.id);
      const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, first.conversation.id));
      expect(messages).toHaveLength(2);
    });
  });

  it("files mail for an unknown address under the unmatched holding client", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      await db.insert(schema.clients).values({ organisationId: o.id, name: "Unmatched inbound", slug: HOLDING_CLIENT_SLUG });

      const result = await ingestInboundEmail(db, o.id, inbound({ to: ["nobody@support.test"] }));

      expect(result.matched).toBe(false);
      const [holding] = await db.select().from(schema.clients)
        .where(and(eq(schema.clients.organisationId, o.id), eq(schema.clients.slug, HOLDING_CLIENT_SLUG)));
      expect(result.conversation.clientId).toBe(holding!.id);
    });
  });

  it("is idempotent for a redelivered provider payload", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const [client] = await db.insert(schema.clients).values({ organisationId: o.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, o.id, { clientId: client!.id }, ENV);
      const payload = inbound({ to: [identity.address] });

      const a = await ingestInboundEmail(db, o.id, payload);
      const b = await ingestInboundEmail(db, o.id, payload);

      expect(b.message.id).toBe(a.message.id);
      const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, a.conversation.id));
      expect(messages).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `ensureEmailIdentity` and `ingestInboundEmail` do not exist.

- [ ] **Step 3: Dependency and domain events**

Add `"@launchos/channels": "workspace:*"` to `dependencies` in `packages/core/package.json`, then run `pnpm install`.

`packages/core/src/events/emit.ts` — add three variants to the union (leave Plan 2's `client.created` variant untouched):
```ts
import type { InboundEmail } from "@launchos/channels";

export type DomainEvent =
  | { name: "incident.opened"; organisationId: string; incidentId: string }
  | { name: "ticket.created"; organisationId: string; ticketId: string }
  | { name: "email.received"; organisationId: string; inbound: InboundEmail }
  | { name: "message.queued"; organisationId: string; messageId: string }
  | {
      name: "approval.decided";
      organisationId: string;
      approvalId: string;
      runId: string;
      decision: "approved" | "rejected";
      note?: string;
    };
```

- [ ] **Step 4: `ensureEmailIdentity`**

`packages/core/src/email/ensure-email-identity.ts`:
```ts
import { randomBytes } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const EnsureEmailIdentityInput = z.object({ clientId: z.string().uuid(), displayName: z.string().optional() });
export type EnsureEmailIdentityInput = z.input<typeof EnsureEmailIdentityInput>;

export function supportAddress(slug: string, domain: string): string {
  return `${slug}@${domain}`.toLowerCase();
}

/**
 * Idempotent: one identity per client, created from the `client.created`
 * handler and backfilled by the seed. The env is injectable so tests do not
 * depend on the developer's .env.
 */
export async function ensureEmailIdentity(
  db: Db,
  organisationId: string,
  input: EnsureEmailIdentityInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  const v = EnsureEmailIdentityInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);

  const [existing] = await db
    .select()
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, v.clientId)));
  if (existing) return existing;

  const domain = env.SUPPORT_EMAIL_DOMAIN;
  if (!domain) throw new Error("SUPPORT_EMAIL_DOMAIN is required to create a support address");
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, v.clientId));

  const [created] = await db
    .insert(schema.emailIdentities)
    .values({
      organisationId,
      clientId: v.clientId,
      address: supportAddress(client!.slug, domain),
      displayName: v.displayName ?? `${client!.name} Support`,
      inboundSecret: randomBytes(24).toString("hex"),
    })
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: "system", action: "email_identity.created", targetType: "email_identity", targetId: created!.id, after: created,
  });
  return created!;
}
```

- [ ] **Step 5: `createTicket` accepts an existing conversation**

In `packages/core/src/support/create-ticket.ts`:

1. Add `conversationId: z.string().uuid().optional()` to `CreateTicketInput`.
2. Import `slaDueAt` from `./sla.js` (create `packages/core/src/support/sla.ts` now, exactly as written in Task 4 Step 3, if Task 4 has not run yet).
3. Inside the transaction, replace the unconditional conversation insert with:
```ts
    const conversation = v.conversationId
      ? (
          await tx.select().from(schema.conversations)
            .where(and(eq(schema.conversations.id, v.conversationId), eq(schema.conversations.organisationId, organisationId)))
        )[0]
      : (
          await tx.insert(schema.conversations).values({
            organisationId, clientId: v.clientId, siteId: v.siteId ?? null, subject: v.subject,
            channel: "internal", lastMessageAt: new Date(),
          }).returning()
        )[0];
    if (!conversation) throw new Error(`conversation ${v.conversationId} not found in organisation`);

    // The opening message is the ticket body only when we made the conversation.
    // An email thread already carries the client's own words.
    if (!v.conversationId) {
      await tx.insert(schema.messages).values({
        organisationId, conversationId: conversation.id, direction: "internal",
        authorKind: v.actorKind, authorId: v.actorId ?? null, body: v.body,
      });
    }
```
4. Add `slaDueAt: slaDueAt(v.severity, new Date())` to the ticket insert values.
5. After the ticket insert, write the back-reference so `conversations.ticket_id` is never stale:
```ts
    await tx.update(schema.conversations)
      .set({ ticketId: ticket!.id, updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversation.id));
```
6. Add `and` to the `drizzle-orm` import.

- [ ] **Step 6: `ingestInboundEmail`**

`packages/core/src/support/ingest-inbound-email.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { InboundEmailSchema, type InboundEmail } from "@launchos/channels";
import { and, eq, inArray } from "drizzle-orm";
import { recordActivity } from "../activity/record-activity.js";
import { notifyOwner } from "../notifications/notify.js";
import { createTicket } from "./create-ticket.js";

export const HOLDING_CLIENT_SLUG = "unmatched";
const CLOSED_TICKET_STATUSES: readonly string[] = ["resolved", "closed"];

/** Thread keys we accept as "same conversation", most specific first. */
function threadCandidates(inbound: InboundEmail): string[] {
  return [...new Set([inbound.inReplyTo, ...inbound.references, inbound.messageId].filter((v): v is string => !!v))];
}

async function resolveClientId(db: Db, organisationId: string, to: string[]) {
  const [identity] = await db
    .select({ clientId: schema.emailIdentities.clientId })
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), inArray(schema.emailIdentities.address, to)));
  if (identity) return { clientId: identity.clientId, matched: true };

  const [holding] = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.slug, HOLDING_CLIENT_SLUG)));
  if (!holding) throw new Error(`holding client "${HOLDING_CLIENT_SLUG}" is missing; run the seed`);
  return { clientId: holding.id, matched: false };
}

export async function ingestInboundEmail(db: Db, organisationId: string, raw: InboundEmail) {
  const inbound = InboundEmailSchema.parse(raw) as InboundEmail;

  // A provider that redelivers the same payload must not double-post the thread.
  const [duplicate] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.organisationId, organisationId), eq(schema.messages.externalId, inbound.messageId)));
  if (duplicate) {
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, duplicate.conversationId));
    const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, conversation!.ticketId!));
    return { conversation: conversation!, message: duplicate, ticket: ticket!, matched: true };
  }

  const { clientId, matched } = await resolveClientId(db, organisationId, inbound.to);
  const subject = inbound.subject.trim() || "(no subject)";

  const appended = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.organisationId, organisationId),
          inArray(schema.conversations.externalThreadKey, threadCandidates(inbound)),
        ),
      );

    const conversation =
      existing ??
      (
        await tx.insert(schema.conversations).values({
          organisationId, clientId, subject, channel: "email", status: "open",
          externalThreadKey: inbound.messageId, participantEmail: inbound.from, lastMessageAt: new Date(),
        }).returning()
      )[0]!;

    const [message] = await tx.insert(schema.messages).values({
      organisationId, conversationId: conversation.id, direction: "inbound", authorKind: "client", authorId: inbound.from,
      body: inbound.text, bodyHtml: inbound.html ?? null, externalId: inbound.messageId,
      fromEmail: inbound.from, toEmail: inbound.to[0]!, subject, rawHeaders: inbound.rawHeaders,
      attachments: inbound.attachments, status: "received", deliveredAt: new Date(),
    }).returning();

    await tx.update(schema.conversations)
      .set({ lastMessageAt: new Date(), status: "open", updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversation.id));

    return { conversation, message: message! };
  });

  const linked = appended.conversation.ticketId
    ? (await db.select().from(schema.tickets).where(eq(schema.tickets.id, appended.conversation.ticketId)))[0]
    : undefined;
  const reusable = linked && !CLOSED_TICKET_STATUSES.includes(linked.status);

  // createTicket owns the ticket + event + audit + `ticket.created` emit, so a
  // new email thread reaches Support Triage down exactly the same path as any
  // other ticket source.
  const ticket = reusable
    ? linked
    : (
        await createTicket(db, organisationId, {
          clientId, conversationId: appended.conversation.id, subject, body: inbound.text || subject,
          source: "email", severity: "medium", actorKind: "client", actorId: inbound.from,
        })
      ).ticket;

  await recordActivity(db, organisationId, {
    clientId, actorKind: "client", actorId: inbound.from, kind: "support.email_received",
    title: `Email received: ${subject}`, link: `/cases/${ticket.id}`,
  });
  if (!matched) {
    await notifyOwner(db, organisationId, {
      kind: "support.unmatched_inbound",
      title: "Email to an unknown support address",
      body: `From ${inbound.from} to ${inbound.to.join(", ")} — filed under the unmatched holding client.`,
      link: `/inbox/${appended.conversation.id}`,
    });
  }

  const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, appended.conversation.id));
  return { conversation: conversation!, message: appended.message, ticket, matched };
}
```

Export `ensureEmailIdentity`, `supportAddress`, `ingestInboundEmail` and `HOLDING_CLIENT_SLUG` from `packages/core/src/index.ts`.

- [ ] **Step 7: Run**

Run: `pnpm --filter @launchos/core test`
Expected: PASS, including the existing `create-ticket.test.ts` (the new `conversationId` is optional).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): per-client email identities and inbound email ingestion"
```

---

### Task 4: Core — ticket lifecycle, SLA, thread replies and outbound send

**Files:**
- Create: `packages/core/src/support/sla.ts`, `update-ticket.ts`, `assign-ticket.ts`, `escalate-ticket.ts`, `reply-to-conversation.ts`, `send-queued-message.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/support/ticket-lifecycle.test.ts`, `packages/core/src/support/reply-to-conversation.test.ts`

**Interfaces:**
- Produces:
  - `SLA_HOURS_BY_SEVERITY`, `slaDueAt(severity, from) → Date`, type `Severity`
  - `updateTicket(db, organisationId, { ticketId, category?, severity?, status?, triage?, actorKind, actorId? }) → Ticket`
  - `assignTicket(db, organisationId, { ticketId, assignedUserId?, actorKind, actorId? }) → Ticket`
  - `escalateTicket(db, organisationId, { ticketId, reason, actorKind, actorId? }) → Ticket`
  - `replyToConversation(db, organisationId, { conversationId, body, actorKind, actorId?, internal? }) → Message`
  - `sendQueuedMessage(db, organisationId, { messageId }, adapter, env?) → Message`
  - `TicketTriageSchema`

- [ ] **Step 1: Failing tests**

`packages/core/src/support/ticket-lifecycle.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { assignTicket } from "./assign-ticket.js";
import { createTicket } from "./create-ticket.js";
import { escalateTicket } from "./escalate-ticket.js";
import { slaDueAt } from "./sla.js";
import { updateTicket } from "./update-ticket.js";

async function seedTicket(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
  const { ticket } = await createTicket(db, org!.id, { clientId: client!.id, subject: "S", body: "B", source: "email" });
  return { organisationId: org!.id, ticket };
}

describe("ticket lifecycle", () => {
  it("computes the SLA window from severity", () => {
    const from = new Date("2026-09-04T10:00:00Z");
    expect(slaDueAt("critical", from).toISOString()).toBe("2026-09-04T12:00:00.000Z");
    expect(slaDueAt("low", from).toISOString()).toBe("2026-09-07T10:00:00.000Z");
  });

  it("stores triage output, recomputes the SLA on a severity change and stamps resolved_at", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ticket } = await seedTicket(db);

      const triaged = await updateTicket(db, organisationId, {
        ticketId: ticket.id, category: "dns", severity: "critical", status: "triaged",
        triage: { category: "dns", severity: "critical", summary: "Nameservers wrong", suggestedFix: "Repoint NS", confidence: 0.82 },
        actorKind: "agent", actorId: "support-triage",
      });
      expect(triaged.status).toBe("triaged");
      expect(triaged.triage).toMatchObject({ category: "dns", confidence: 0.82 });
      expect(triaged.slaDueAt!.getTime()).toBe(slaDueAt("critical", triaged.createdAt).getTime());
      expect(triaged.resolvedAt).toBeNull();

      const resolved = await updateTicket(db, organisationId, { ticketId: ticket.id, status: "resolved", actorKind: "user", actorId: "u1" });
      expect(resolved.resolvedAt).toBeInstanceOf(Date);

      const events = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticket.id));
      expect(events.map((e) => e.kind)).toContain("status_changed");
    });
  });

  it("assigns explicitly and escalates with a reason", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ticket } = await seedTicket(db);

      const assigned = await assignTicket(db, organisationId, {
        ticketId: ticket.id, assignedUserId: "user-1", actorKind: "agent", actorId: "support-triage",
      });
      expect(assigned.assignedUserId).toBe("user-1");

      const escalated = await escalateTicket(db, organisationId, {
        ticketId: ticket.id, reason: "Needs Shoji", actorKind: "agent", actorId: "support-triage",
      });
      expect(escalated.escalated).toBe(true);
      expect(escalated.escalationReason).toBe("Needs Shoji");
      expect(escalated.severity).toBe("high");

      const events = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticket.id));
      expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["assigned", "escalated"]));
    });
  });
});
```

`packages/core/src/support/reply-to-conversation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import { ensureEmailIdentity } from "../email/ensure-email-identity.js";
import { ingestInboundEmail } from "./ingest-inbound-email.js";
import { replyToConversation } from "./reply-to-conversation.js";
import { sendQueuedMessage } from "./send-queued-message.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test", MAIL_FROM: "LaunchFlow <support@launchflow.test>" };

describe("replyToConversation + sendQueuedMessage", () => {
  it("queues an outbound reply, stamps first_response_at, then sends it via the adapter", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
      const ingested = await ingestInboundEmail(db, org!.id, {
        provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Site is down", text: "503",
        messageId: "<in-1@client.test>", references: [], attachments: [], rawHeaders: {},
      });

      const queued = await replyToConversation(db, org!.id, {
        conversationId: ingested.conversation.id, body: "We have restarted the container.", actorKind: "user", actorId: "u1",
      });
      expect(queued.direction).toBe("outbound");
      expect(queued.status).toBe("queued");
      expect(queued.toEmail).toBe("jo@client.test");
      expect(queued.fromEmail).toBe(identity.address);
      expect(queued.subject).toBe("Re: Site is down");

      const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ingested.ticket.id));
      expect(ticket!.firstResponseAt).toBeInstanceOf(Date);

      const adapter = new MockEmailAdapter();
      const sent = await sendQueuedMessage(db, org!.id, { messageId: queued.id }, adapter, ENV);
      expect(sent.status).toBe("sent");
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0]!.inReplyTo).toBe("<in-1@client.test>");
      expect(adapter.sent[0]!.replyTo).toBe(identity.address);

      // A retried job must not send twice.
      await sendQueuedMessage(db, org!.id, { messageId: queued.id }, adapter, ENV);
      expect(adapter.sent).toHaveLength(1);
    });
  });

  it("records an internal note with no email status and does not queue a send", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const [conversation] = await db.insert(schema.conversations).values({
        organisationId: org!.id, clientId: client!.id, subject: "S", channel: "email", participantEmail: "jo@client.test",
      }).returning();

      const note = await replyToConversation(db, org!.id, {
        conversationId: conversation!.id, body: "Chased hosting.", actorKind: "user", actorId: "u1", internal: true,
      });
      expect(note.direction).toBe("internal");
      expect(note.status).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — none of the six modules exist.

- [ ] **Step 3: SLA**

`packages/core/src/support/sla.ts`:
```ts
export type Severity = "low" | "medium" | "high" | "critical";

/** Calendar hours from ticket creation. Business-hours SLAs are out of scope for v1. */
export const SLA_HOURS_BY_SEVERITY: Record<Severity, number> = { low: 72, medium: 48, high: 8, critical: 2 };

export function slaDueAt(severity: Severity, from: Date): Date {
  return new Date(from.getTime() + SLA_HOURS_BY_SEVERITY[severity] * 60 * 60 * 1000);
}
```

- [ ] **Step 4: `updateTicket`**

`packages/core/src/support/update-ticket.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { slaDueAt, type Severity } from "./sla.js";

export const TicketTriageSchema = z.object({
  category: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().min(1),
  suggestedFix: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const UpdateTicketInput = z.object({
  ticketId: z.string().uuid(),
  category: z.enum(["hosting", "dns", "content", "email", "ads", "billing", "other"]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  status: z.enum(["open", "triaged", "in_progress", "waiting_client", "resolved", "closed"]).optional(),
  triage: TicketTriageSchema.optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type UpdateTicketInput = z.input<typeof UpdateTicketInput>;

const CLOSING = new Set(["resolved", "closed"]);

export async function updateTicket(db: Db, organisationId: string, input: UpdateTicketInput) {
  const v = UpdateTicketInput.parse(input);
  await assertOwned(db, organisationId, schema.tickets, v.ticketId);

  const where = and(eq(schema.tickets.id, v.ticketId), eq(schema.tickets.organisationId, organisationId));
  const [before] = await db.select().from(schema.tickets).where(where);
  if (!before) throw new Error(`ticket ${v.ticketId} not found in organisation`);

  const severity = (v.severity ?? before.severity) as Severity;
  const [after] = await db
    .update(schema.tickets)
    .set({
      category: v.category ?? before.category,
      severity,
      status: v.status ?? before.status,
      triage: v.triage ?? before.triage,
      // Severity *is* the SLA: change one and the other follows.
      slaDueAt: v.severity ? slaDueAt(severity, before.createdAt) : before.slaDueAt,
      resolvedAt: v.status && CLOSING.has(v.status) ? (before.resolvedAt ?? new Date()) : before.resolvedAt,
      updatedAt: new Date(),
    })
    .where(where)
    .returning();

  if (v.status && v.status !== before.status) {
    await db.insert(schema.ticketEvents).values({
      organisationId, ticketId: v.ticketId, kind: "status_changed",
      actorKind: v.actorKind, actorId: v.actorId ?? null, data: { from: before.status, to: v.status },
    });
  }
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "ticket.updated",
    targetType: "ticket", targetId: v.ticketId, before, after,
  });
  return after!;
}
```

- [ ] **Step 5: `assignTicket` and `escalateTicket`**

`packages/core/src/support/assign-ticket.ts` follows the same shape as `updateTicket`:

```ts
export const AssignTicketInput = z.object({
  ticketId: z.string().uuid(),
  assignedUserId: z.string().min(1).optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
```
`assignTicket` asserts ownership with `assertOwned(db, organisationId, schema.tickets, v.ticketId)`, resolves the assignee with `v.assignedUserId ?? (await pickLeastLoadedStaff(db, organisationId))` (Plan 3) and throws `new Error("no staff available to assign")` when that is `null`, updates `assignedUserId` with `update … returning`, inserts a `ticket_events` row of kind `assigned` with `data: { from: before.assignedUserId, to: assignedUserId }`, and audits `ticket.assigned`.

`packages/core/src/support/escalate-ticket.ts` follows the same shape:

```ts
export const EscalateTicketInput = z.object({
  ticketId: z.string().uuid(),
  reason: z.string().min(1).max(1000),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
```
`escalateTicket` sets `escalated: true`, `escalationReason: v.reason`, and raises `severity` to `"high"` when it is currently `"low"` or `"medium"` (recomputing `slaDueAt` with `slaDueAt("high", before.createdAt)`), inserts a `ticket_events` row of kind `escalated` with `data: { reason: v.reason }`, audits `ticket.escalated`, and finishes with:
```ts
  await notifyOwner(db, organisationId, {
    kind: "support.escalated",
    title: `Escalated: ${after!.subject}`,
    body: v.reason,
    link: `/cases/${v.ticketId}`,
  });
```

- [ ] **Step 6: `replyToConversation`**

`packages/core/src/support/reply-to-conversation.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const ReplyToConversationInput = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
  internal: z.boolean().default(false),
});
export type ReplyToConversationInput = z.input<typeof ReplyToConversationInput>;

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * Appends to a thread. An internal note stays inside LaunchOS: no email status,
 * no job. An outbound reply is written `queued` and emits `message.queued`; the
 * worker's `outbound.message` job is the only thing that talks to a mail server.
 */
export async function replyToConversation(db: Db, organisationId: string, input: ReplyToConversationInput) {
  const v = ReplyToConversationInput.parse(input);
  await assertOwned(db, organisationId, schema.conversations, v.conversationId);

  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, v.conversationId), eq(schema.conversations.organisationId, organisationId)));
  if (!conversation) throw new Error(`conversation ${v.conversationId} not found in organisation`);

  const outbound = !v.internal;
  const [identity] = await db
    .select()
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, conversation.clientId)));
  if (outbound && !conversation.participantEmail) throw new Error("conversation has no participant email to reply to");
  if (outbound && !identity) throw new Error("client has no support email identity; run ensureEmailIdentity");

  const [lastInbound] = await db
    .select({ externalId: schema.messages.externalId })
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.direction, "inbound")))
    .orderBy(desc(schema.messages.createdAt))
    .limit(1);

  const created = await db.transaction(async (tx) => {
    const [message] = await tx.insert(schema.messages).values({
      organisationId,
      conversationId: conversation.id,
      direction: outbound ? "outbound" : "internal",
      authorKind: v.actorKind,
      authorId: v.actorId ?? null,
      body: v.body,
      fromEmail: outbound ? identity!.address : null,
      toEmail: outbound ? conversation.participantEmail : null,
      subject: outbound ? replySubject(conversation.subject) : null,
      rawHeaders: outbound && lastInbound?.externalId ? { "in-reply-to": lastInbound.externalId } : {},
      status: outbound ? "queued" : null,
    }).returning();

    await tx.update(schema.conversations)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversation.id));

    // The first response on the linked ticket stops the SLA clock. `isNull`
    // makes this a no-op on every later reply without a read-then-write race.
    if (outbound && conversation.ticketId) {
      await tx.update(schema.tickets)
        .set({ firstResponseAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.tickets.id, conversation.ticketId),
          eq(schema.tickets.organisationId, organisationId),
          isNull(schema.tickets.firstResponseAt),
        ));
    }

    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId,
      action: outbound ? "message.queued" : "message.note_added",
      targetType: "message", targetId: message!.id, after: message,
    });
    return message!;
  });

  if (outbound) await emit({ name: "message.queued", organisationId, messageId: created.id });
  return created;
}
```

- [ ] **Step 7: `sendQueuedMessage`**

`packages/core/src/support/send-queued-message.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { EmailAdapter } from "@launchos/channels";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const SendQueuedMessageInput = z.object({ messageId: z.string().uuid() });
export type SendQueuedMessageInput = z.input<typeof SendQueuedMessageInput>;

async function patchMessage(db: Db, organisationId: string, messageId: string, patch: Record<string, unknown>) {
  const [row] = await db
    .update(schema.messages)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.organisationId, organisationId)))
    .returning();
  return row!;
}

export async function sendQueuedMessage(
  db: Db,
  organisationId: string,
  input: SendQueuedMessageInput,
  adapter: EmailAdapter,
  env: NodeJS.ProcessEnv = process.env,
) {
  const v = SendQueuedMessageInput.parse(input);
  const [message] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.id, v.messageId), eq(schema.messages.organisationId, organisationId)));
  if (!message) throw new Error(`message ${v.messageId} not found in organisation`);
  // A pg-boss retry of an already-sent job must not send twice.
  if (message.status !== "queued") return message;
  if (!message.toEmail || !message.fromEmail) throw new Error(`message ${v.messageId} is not addressable`);

  const inReplyTo = message.rawHeaders["in-reply-to"];
  try {
    const result = await adapter.send({
      to: message.toEmail,
      // The envelope sender is the verified MAIL_FROM; the client's own support
      // address is the Reply-To so their answer threads back to them.
      from: env.MAIL_FROM ?? message.fromEmail,
      replyTo: message.fromEmail,
      subject: message.subject ?? "(no subject)",
      text: message.body,
      inReplyTo,
      references: inReplyTo ? [inReplyTo] : undefined,
    });
    const sent = await patchMessage(db, organisationId, v.messageId, {
      status: "sent", deliveredAt: new Date(), externalId: result.providerMessageId,
    });
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "message.sent", targetType: "message", targetId: v.messageId, before: message, after: sent,
    });
    return sent;
  } catch (err) {
    await patchMessage(db, organisationId, v.messageId, { status: "failed" });
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "message.send_failed", targetType: "message", targetId: v.messageId,
      after: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err; // let pg-boss retry
  }
}
```

Export all six modules (and `TicketTriageSchema`, `SLA_HOURS_BY_SEVERITY`, `slaDueAt`) from `packages/core/src/index.ts`.

- [ ] **Step 8: Run**

Run: `pnpm --filter @launchos/core test && pnpm --filter @launchos/core typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): ticket lifecycle, SLA windows, thread replies and outbound send"
```

---

### Task 5: Core — knowledge articles with full-text search, and client users

**Files:**
- Create: `packages/core/src/knowledge/create-article.ts`, `update-article.ts`, `delete-article.ts`, `search-knowledge.ts`, `list-articles.ts`
- Create: `packages/core/src/client-users/create-client-user.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json`
- Test: `packages/core/src/knowledge/search-knowledge.test.ts`, `packages/core/src/client-users/create-client-user.test.ts`

**Interfaces:**
- Produces:
  - `createKnowledgeArticle(db, organisationId, { title, slug?, bodyMd, tags?, published? }) → KnowledgeArticle`
  - `updateKnowledgeArticle(db, organisationId, { articleId, title?, bodyMd?, tags?, published? }) → KnowledgeArticle`
  - `deleteKnowledgeArticle(db, organisationId, { articleId }) → void` (soft delete)
  - `listKnowledgeArticles(db, organisationId, { includeUnpublished? }) → KnowledgeArticle[]`
  - `searchKnowledge(db, organisationId, query, limit?) → KnowledgeHit[]` where `KnowledgeHit = { id, title, slug, excerpt, tags, rank }`
  - `slugify(value) → string`
  - `createClientUser(db, organisationId, { clientId, email, name }) → { user, clientUser, oneTimePassword }`

- [ ] **Step 1: Failing tests**

`packages/core/src/knowledge/search-knowledge.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createKnowledgeArticle } from "./create-article.js";
import { deleteKnowledgeArticle } from "./delete-article.js";
import { searchKnowledge } from "./search-knowledge.js";
import { updateKnowledgeArticle } from "./update-article.js";

async function newOrg(db: Db) {
  const [o] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return o!;
}

describe("knowledge articles", () => {
  it("ranks a full-text match above an unrelated article and ignores unpublished ones", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const dns = await createKnowledgeArticle(db, o.id, {
        title: "DNS propagation", bodyMd: "Nameserver changes take up to 48 hours to propagate worldwide.",
        tags: ["dns"], published: true,
      });
      await createKnowledgeArticle(db, o.id, {
        title: "SSL renewal", bodyMd: "Certificates renew automatically 30 days before expiry.", tags: ["ssl"], published: true,
      });
      await createKnowledgeArticle(db, o.id, {
        title: "Draft nameserver notes", bodyMd: "Nameserver propagate propagate.", published: false,
      });

      const hits = await searchKnowledge(db, o.id, "nameserver propagation");
      expect(hits[0]!.id).toBe(dns.id);
      expect(hits.map((h) => h.title)).not.toContain("Draft nameserver notes");
      expect(hits[0]!.rank).toBeGreaterThan(0);
    });
  });

  it("derives a unique slug, updates the body and soft-deletes", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const created = await createKnowledgeArticle(db, o.id, { title: "Site Down Checklist", bodyMd: "Check hosting first.", published: true });
      expect(created.slug).toBe("site-down-checklist");

      const updated = await updateKnowledgeArticle(db, o.id, { articleId: created.id, bodyMd: "Check DNS first.", tags: ["hosting"] });
      expect(updated.bodyMd).toBe("Check DNS first.");
      expect(updated.tags).toEqual(["hosting"]);

      await deleteKnowledgeArticle(db, o.id, { articleId: created.id });
      const [row] = await db.select().from(schema.knowledgeArticles).where(eq(schema.knowledgeArticles.id, created.id));
      expect(row!.deletedAt).toBeInstanceOf(Date);
      expect(await searchKnowledge(db, o.id, "hosting")).toHaveLength(0);
    });
  });

  it("returns nothing rather than throwing for a query with no searchable words", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      await createKnowledgeArticle(db, o.id, { title: "T", bodyMd: "B", published: true });
      expect(await searchKnowledge(db, o.id, "   &&&   ")).toEqual([]);
    });
  });
});
```

`packages/core/src/client-users/create-client-user.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClientUser } from "./create-client-user.js";

describe("createClientUser", () => {
  it("creates a Better Auth user with a credential account and links it to the client", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const email = `portal-${crypto.randomUUID()}@client.test`;

      const result = await createClientUser(db, org!.id, { clientId: client!.id, email, name: "Jo Client" });

      expect(result.oneTimePassword).toHaveLength(16);
      expect(result.user.email).toBe(email);
      expect(result.clientUser.clientId).toBe(client!.id);
      const [account] = await db.select().from(schema.account).where(eq(schema.account.userId, result.user.id));
      expect(account!.providerId).toBe("credential");
      expect(account!.password).not.toContain(result.oneTimePassword);
    });
  });

  it("refuses to invite the same email twice for one client", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const email = `portal-${crypto.randomUUID()}@client.test`;
      await createClientUser(db, org!.id, { clientId: client!.id, email, name: "Jo" });
      await expect(createClientUser(db, org!.id, { clientId: client!.id, email, name: "Jo" })).rejects.toThrow(/already/i);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — the knowledge and client-users modules do not exist.

- [ ] **Step 3: Knowledge CRUD**

Add `"better-auth": "^1.7.2"` to `dependencies` in `packages/core/package.json` (needed by Step 5), then `pnpm install`.

`packages/core/src/knowledge/create-article.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const CreateKnowledgeArticleInput = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).optional(),
  bodyMd: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  published: z.boolean().default(false),
});
export type CreateKnowledgeArticleInput = z.input<typeof CreateKnowledgeArticleInput>;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200) || "article";
}

/** Appends -2, -3 … until the (organisation, slug) unique index is satisfied. */
async function uniqueSlug(db: Db, organisationId: string, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [clash] = await db
      .select({ id: schema.knowledgeArticles.id })
      .from(schema.knowledgeArticles)
      .where(and(eq(schema.knowledgeArticles.organisationId, organisationId), eq(schema.knowledgeArticles.slug, candidate)));
    if (!clash) return candidate;
  }
  throw new Error(`could not find a free slug for "${base}"`);
}

export async function createKnowledgeArticle(db: Db, organisationId: string, input: CreateKnowledgeArticleInput) {
  const v = CreateKnowledgeArticleInput.parse(input);
  const slug = await uniqueSlug(db, organisationId, slugify(v.slug ?? v.title));
  const [created] = await db
    .insert(schema.knowledgeArticles)
    .values({ organisationId, title: v.title, slug, bodyMd: v.bodyMd, tags: v.tags, published: v.published })
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", action: "knowledge_article.created", targetType: "knowledge_article", targetId: created!.id, after: created,
  });
  return created!;
}
```

`packages/core/src/knowledge/update-article.ts` follows the same shape with
`UpdateKnowledgeArticleInput = z.object({ articleId: z.string().uuid(), title: …optional(), bodyMd: …optional(), tags: …optional(), published: …optional() })`.
It calls `assertOwned(db, organisationId, schema.knowledgeArticles, v.articleId)`, reads `before`, writes only the supplied fields with `update … returning`, and audits `knowledge_article.updated`.

`packages/core/src/knowledge/delete-article.ts` sets `deletedAt: new Date()` (soft delete, so agent runs that cited an article still resolve) and audits `knowledge_article.deleted`.

`packages/core/src/knowledge/list-articles.ts`:
```ts
export async function listKnowledgeArticles(db: Db, organisationId: string, input: { includeUnpublished?: boolean } = {}) {
  const conditions = [eq(schema.knowledgeArticles.organisationId, organisationId), isNull(schema.knowledgeArticles.deletedAt)];
  if (!input.includeUnpublished) conditions.push(eq(schema.knowledgeArticles.published, true));
  return db.select().from(schema.knowledgeArticles).where(and(...conditions)).orderBy(asc(schema.knowledgeArticles.title));
}
```

- [ ] **Step 4: `searchKnowledge`**

`packages/core/src/knowledge/search-knowledge.ts`:
```ts
import type { Db } from "@launchos/db";
import { sql } from "drizzle-orm";

export interface KnowledgeHit { id: string; title: string; slug: string; excerpt: string; tags: string[]; rank: number }

export const KNOWLEDGE_SEARCH_LIMIT = 5;

/**
 * `plainto_tsquery` treats the query as plain words, so nothing a client (or a
 * model) types can inject tsquery operators. A query with no lexemes matches
 * nothing rather than erroring, so the caller gets `[]`.
 */
export async function searchKnowledge(
  db: Db,
  organisationId: string,
  query: string,
  limit = KNOWLEDGE_SEARCH_LIMIT,
): Promise<KnowledgeHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const rows = await db.execute<{ id: string; title: string; slug: string; excerpt: string; tags: string[]; rank: number }>(sql`
    select
      a.id,
      a.title,
      a.slug,
      ts_headline('english', a.body_md, q, 'MaxWords=40, MinWords=15, ShortWord=3, MaxFragments=1') as excerpt,
      a.tags,
      ts_rank(a.search, q) as rank
    from knowledge_articles a, plainto_tsquery('english', ${trimmed}) q
    where a.organisation_id = ${organisationId}
      and a.deleted_at is null
      and a.published = true
      and a.search @@ q
    order by rank desc, a.title asc
    limit ${Math.max(1, Math.min(limit, 20))}
  `);
  return rows.map((r) => ({ ...r, rank: Number(r.rank) }));
}
```

- [ ] **Step 5: `createClientUser`**

`packages/core/src/client-users/create-client-user.ts`:
```ts
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const CreateClientUserInput = z.object({
  clientId: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(120),
});
export type CreateClientUserInput = z.input<typeof CreateClientUserInput>;

// Better Auth namespaces credential accounts as "local:<providerId>"; the seed
// uses the same two constants.
const CREDENTIAL_PROVIDER = "credential";
const CREDENTIAL_ISSUER = `local:${CREDENTIAL_PROVIDER}`;
const OTP_LENGTH = 16;

/** URL-safe, no ambiguous characters, shown to Shoji exactly once. */
function oneTimePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(OTP_LENGTH);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * Admin-created portal account. Sign-up stays disabled in Better Auth, so this
 * is the only way a client user comes into existence. The plaintext password is
 * returned once and never stored.
 */
export async function createClientUser(db: Db, organisationId: string, input: CreateClientUserInput) {
  const v = CreateClientUserInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  const email = v.email.trim().toLowerCase();

  const [existingUser] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  if (existingUser) {
    const [link] = await db
      .select()
      .from(schema.clientUsers)
      .where(and(eq(schema.clientUsers.organisationId, organisationId), eq(schema.clientUsers.userId, existingUser.id)));
    if (link) throw new Error(`${email} already has a portal account`);
  }

  const password = oneTimePassword();
  const hashed = await hashPassword(password);

  const created = await db.transaction(async (tx) => {
    const user =
      existingUser ??
      (await tx.insert(schema.user).values({ id: randomUUID(), name: v.name, email, emailVerified: true }).returning())[0]!;
    if (!existingUser) {
      await tx.insert(schema.account).values({
        id: randomUUID(), accountId: user.id, providerId: CREDENTIAL_PROVIDER, issuer: CREDENTIAL_ISSUER,
        userId: user.id, password: hashed,
      });
    }
    const [clientUser] = await tx
      .insert(schema.clientUsers)
      .values({ organisationId, clientId: v.clientId, userId: user.id, role: "client_admin" })
      .returning();
    return { user, clientUser: clientUser! };
  });

  await recordAudit(db, organisationId, {
    actorKind: "user", action: "client_user.created", targetType: "client_user", targetId: created.clientUser.id,
    after: { clientId: v.clientId, userId: created.user.id, email },
  });
  await recordActivity(db, organisationId, {
    clientId: v.clientId, actorKind: "user", kind: "portal.user_invited",
    title: `Portal access granted to ${email}`, link: `/clients/${v.clientId}/portal-users`,
  });

  return { ...created, oneTimePassword: password };
}
```

Export everything new from `packages/core/src/index.ts`.

- [ ] **Step 6: Run**

Run: `pnpm --filter @launchos/core test && pnpm --filter @launchos/core typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): knowledge base with full-text search and admin-created client users"
```

---

### Task 6: Agent kernel — extract the run loop and add `resumeAgent`

**Files:**
- Create: `packages/agents/src/kernel/run-loop.ts`, `packages/agents/src/kernel/resume-agent.ts`
- Modify: `packages/agents/src/kernel/run-agent.ts`, `packages/agents/src/kernel/run-recorder.ts`, `packages/agents/src/index.ts`
- Test: `packages/agents/src/kernel/resume-agent.test.ts`

**Interfaces:**
- Produces:
  - `runLoop(def, ctx, recorder, llm, policy, messages) → AgentRunResult`
  - `buildContext(db, organisationId, runId, logger, now?) → AgentContext`
  - `RunRecorder.reopen(db, organisationId, runId) → RunRecorder` (continues the `seq` sequence, sets the run back to `running`)
  - `resumeAgent(def, { db, organisationId, runId, approvalId, decision, note?, llm, policy, logger, now? }) → AgentRunResult`
  - `PendingState` Zod schema for `agent_runs.metadata.pending`

- [ ] **Step 1: Failing test**

`packages/agents/src/kernel/resume-agent.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { FakeLlmClient, text, toolUse } from "./llm.js";
import { resumeAgent } from "./resume-agent.js";
import { runAgent } from "./run-agent.js";
import { defineTool, type AgentDefinition } from "./types.js";

const pingCalls: unknown[] = [];
const ping = defineTool({
  name: "ping", description: "ping", input: z.object({ host: z.string() }), risk: "safe",
  execute: async (input) => { pingCalls.push(input); return { ok: true }; },
});
const sendMailCalls: unknown[] = [];
const sendMail = defineTool({
  name: "send_mail", description: "send", input: z.object({ to: z.string() }), risk: "requires_approval",
  execute: async (input) => { sendMailCalls.push(input); return { sent: true }; },
});

const agent: AgentDefinition = {
  key: "test-agent", name: "Test", description: "", trigger: { kind: "manual" },
  systemPrompt: "You test.", tools: [ping, sendMail], maxTurns: 4,
};

async function park(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const llm = new FakeLlmClient([
    {
      content: [toolUse("tu_a", "ping", { host: "a.test" }), toolUse("tu_b", "send_mail", { to: "jo@c.test" }), toolUse("tu_c", "ping", { host: "b.test" })],
      stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  const run = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
  const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.runId));
  return { organisationId: org!.id, run, approval: approval! };
}

describe("resumeAgent", () => {
  beforeEach(() => { pingCalls.length = 0; sendMailCalls.length = 0; });

  it("executes the approved tool, skips the remaining tool uses and completes the run", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      expect(run.status).toBe("awaiting_approval");
      pingCalls.length = 0;

      const llm = new FakeLlmClient([{ content: [text("Reply sent.")], stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 2 } }]);
      const resumed = await resumeAgent(agent, {
        db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
        llm, policy: "safe", logger: console,
      });

      expect(resumed.status).toBe("completed");
      expect(resumed.runId).toBe(run.runId);
      expect(sendMailCalls).toEqual([{ to: "jo@c.test" }]);
      // The already-completed ping is replayed from metadata, not re-executed.
      expect(pingCalls).toEqual([]);

      const results = llm.requests[0]!.messages.at(-1)!.content as Array<{ tool_use_id: string; is_error?: boolean; content: unknown }>;
      expect(results.map((r) => r.tool_use_id)).toEqual(["tu_a", "tu_b", "tu_c"]);
      expect(results.find((r) => r.tool_use_id === "tu_c")!.is_error).toBe(true);
      expect(results.find((r) => r.tool_use_id === "tu_c")!.content).toBe("skipped pending approval");

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("completed");
      expect(row!.finishedAt).toBeInstanceOf(Date);
      expect(row!.metadata).toEqual({});

      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, run.runId)).orderBy(schema.agentSteps.seq);
      expect(steps.map((s) => s.seq)).toEqual([...steps.keys()].map((i) => i + 1)); // seq continues, never restarts
      expect(steps.map((s) => s.kind)).toContain("tool_result");
    });
  });

  it("feeds a rejection back to the model instead of running the tool", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      const llm = new FakeLlmClient([{ content: [text("Understood, escalating instead.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }]);

      const resumed = await resumeAgent(agent, {
        db, organisationId, runId: run.runId, approvalId: approval.id, decision: "rejected", note: "Wrong tone",
        llm, policy: "safe", logger: console,
      });

      expect(resumed.status).toBe("completed");
      expect(sendMailCalls).toEqual([]);
      const results = llm.requests[0]!.messages.at(-1)!.content as Array<{ tool_use_id: string; is_error?: boolean; content: string }>;
      const rejected = results.find((r) => r.tool_use_id === "tu_b")!;
      expect(rejected.is_error).toBe(true);
      expect(rejected.content).toBe("rejected by human: Wrong tone");
    });
  });

  it("refuses to resume a run that is not awaiting approval", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await db.update(schema.agentRuns).set({ status: "completed" }).where(eq(schema.agentRuns.id, run.runId));
      await expect(
        resumeAgent(agent, {
          db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
          llm: new FakeLlmClient([]), policy: "safe", logger: console,
        }),
      ).rejects.toThrow(/awaiting_approval/);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @launchos/agents test`
Expected: FAIL — `./resume-agent.js` does not exist.

- [ ] **Step 3: `RunRecorder.reopen`**

In `packages/agents/src/kernel/run-recorder.ts` add `desc` to the `drizzle-orm` import and:
```ts
  /**
   * Continues an existing run after an approval decision. `seq` picks up from
   * the highest step already recorded so the (run_id, seq) unique index holds
   * and the trace in the admin portal reads as one story.
   */
  static async reopen(db: Db, organisationId: string, runId: string): Promise<RunRecorder> {
    const [run] = await db
      .select({ id: schema.agentRuns.id, status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.organisationId, organisationId)));
    if (!run) throw new Error(`agent run ${runId} not found in organisation`);
    if (run.status !== "awaiting_approval") throw new Error(`agent run ${runId} is ${run.status}, expected awaiting_approval`);

    const [last] = await db
      .select({ seq: schema.agentSteps.seq })
      .from(schema.agentSteps)
      .where(eq(schema.agentSteps.runId, runId))
      .orderBy(desc(schema.agentSteps.seq))
      .limit(1);

    await db.update(schema.agentRuns).set({ status: "running", updatedAt: new Date() }).where(eq(schema.agentRuns.id, runId));
    const recorder = new RunRecorder(db, organisationId, runId);
    recorder.seq = last?.seq ?? 0;
    return recorder;
  }
```
Add `and` to the `drizzle-orm` import too.

- [ ] **Step 4: Extract the loop**

Create `packages/agents/src/kernel/run-loop.ts` by moving `extractText`, `buildPendingMetadata`, `handleToolUses`, `parkForApproval`, the `ToolResultBlock` and `ToolUseOutcome` types, and the `for (let turn …)` body out of `run-agent.ts` unchanged, plus:
```ts
export function buildContext(db: Db, organisationId: string, runId: string, logger: Logger, now?: () => Date): AgentContext {
  return { organisationId, runId, db, logger, now: now ?? (() => new Date()) };
}

/**
 * The shared LLM ↔ tool loop. `runAgent` enters it with the payload as the
 * first user message; `resumeAgent` enters it with the parked message list plus
 * the approval's tool results. Neither owns the loop, so the two paths can
 * never drift.
 */
export async function runLoop(
  def: AgentDefinition,
  ctx: AgentContext,
  recorder: RunRecorder,
  llm: LlmClient,
  policy: AgentPolicy,
  initialMessages: Anthropic.Beta.BetaMessageParam[],
): Promise<AgentRunResult> {
  const tools = toClaudeTools(def.tools);
  const model = def.model ?? process.env.AGENT_MODEL ?? "claude-opus-5";
  let messages = initialMessages;
  try {
    for (let turn = 0; turn < def.maxTurns; turn++) {
      // …body moved verbatim from run-agent.ts, using `ctx`, `recorder`, `llm`, `policy`…
    }
    await recorder.finish("failed", `Stopped after maxTurns=${def.maxTurns}`, "max_turns");
    return { runId: recorder.runId, status: "failed", summary: `Stopped after maxTurns=${def.maxTurns}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error("agent run failed", { runId: recorder.runId, err: message });
    await recorder.finish("failed", "Run failed", message);
    return { runId: recorder.runId, status: "failed", summary: message };
  }
}
```
`packages/agents/src/kernel/run-agent.ts` keeps only `RunAgentOptions` and:
```ts
export async function runAgent(def: AgentDefinition, opts: RunAgentOptions): Promise<AgentRunResult> {
  const recorder = await RunRecorder.open(opts.db, opts.organisationId, def.key, opts.trigger, opts.payload);
  const ctx = buildContext(opts.db, opts.organisationId, recorder.runId, opts.logger, opts.now);
  return runLoop(def, ctx, recorder, opts.llm, opts.policy, [{ role: "user", content: JSON.stringify(opts.payload) }]);
}
```

Run: `pnpm --filter @launchos/agents test`
Expected: the three existing `run-agent.test.ts` cases and `hosting-guard-dog.test.ts` still PASS; only `resume-agent.test.ts` fails.

- [ ] **Step 5: `resumeAgent`**

`packages/agents/src/kernel/resume-agent.ts`:
```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { LlmClient } from "./llm.js";
import { buildContext, runLoop } from "./run-loop.js";
import { RunRecorder } from "./run-recorder.js";
import { findTool } from "./tool-registry.js";
import type { AgentContext, AgentDefinition, AgentPolicy, AgentRunResult, Logger, ToolDefinition } from "./types.js";

type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;

export const PendingState = z.object({
  messages: z.array(z.unknown()),
  completedResults: z.array(z.unknown()).default([]),
  awaitingToolUseId: z.string().min(1),
  remainingToolUseIds: z.array(z.string()).default([]),
});

const ApprovalPayload = z.object({ toolName: z.string().min(1), input: z.unknown() });

export interface ResumeAgentOptions {
  db: Db;
  organisationId: string;
  runId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  note?: string;
  llm: LlmClient;
  policy: AgentPolicy;
  logger: Logger;
  now?: () => Date;
}

async function executeApprovedTool(
  tool: ToolDefinition,
  rawInput: unknown,
  toolUseId: string,
  ctx: AgentContext,
  recorder: RunRecorder,
): Promise<ToolResultBlock> {
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    await recorder.step("tool_call", { toolName: tool.name, input: rawInput, output: { error: parsed.error.message } });
    return { type: "tool_result", tool_use_id: toolUseId, content: `Invalid input: ${parsed.error.message}`, is_error: true };
  }
  await recorder.step("tool_call", { toolName: tool.name, input: parsed.data });
  try {
    const output = await tool.execute(parsed.data, ctx);
    await recorder.step("tool_result", { toolName: tool.name, output });
    return { type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify(output) };
  } catch (err) {
    // A failing approved tool must not lose the run: hand the model the error
    // and let it decide what to do next.
    const message = err instanceof Error ? err.message : String(err);
    await recorder.step("tool_result", { toolName: tool.name, output: { error: message } });
    return { type: "tool_result", tool_use_id: toolUseId, content: `Tool failed: ${message}`, is_error: true };
  }
}

/**
 * Continues a run parked by the policy gate. The human already decided, so the
 * awaiting tool executes without consulting the gate again; every later turn
 * goes through the gate as normal.
 */
export async function resumeAgent(def: AgentDefinition, opts: ResumeAgentOptions): Promise<AgentRunResult> {
  const [run] = await opts.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.id, opts.runId), eq(schema.agentRuns.organisationId, opts.organisationId)));
  if (!run) throw new Error(`agent run ${opts.runId} not found in organisation`);
  const pending = PendingState.parse((run.metadata as { pending?: unknown }).pending);

  const [approval] = await opts.db
    .select()
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.id, opts.approvalId),
      eq(schema.approvals.organisationId, opts.organisationId),
      eq(schema.approvals.runId, opts.runId),
    ));
  if (!approval) throw new Error(`approval ${opts.approvalId} does not belong to run ${opts.runId}`);
  const payload = ApprovalPayload.parse(approval.payload);

  // reopen() is what enforces status === "awaiting_approval".
  const recorder = await RunRecorder.reopen(opts.db, opts.organisationId, opts.runId);
  const ctx = buildContext(opts.db, opts.organisationId, opts.runId, opts.logger, opts.now);

  const results: ToolResultBlock[] = [...(pending.completedResults as ToolResultBlock[])];
  if (opts.decision === "approved") {
    const tool = findTool(def.tools, payload.toolName);
    if (!tool) throw new Error(`approved tool ${payload.toolName} is not registered on agent ${def.key}`);
    results.push(await executeApprovedTool(tool, payload.input, pending.awaitingToolUseId, ctx, recorder));
  } else {
    const note = opts.note?.trim() ?? "";
    await recorder.step("note", { toolName: payload.toolName, input: payload.input, output: { rejected: true, note } });
    results.push({
      type: "tool_result",
      tool_use_id: pending.awaitingToolUseId,
      content: `rejected by human: ${note.length > 0 ? note : "no reason given"}`,
      is_error: true,
    });
  }
  for (const id of pending.remainingToolUseIds) {
    results.push({ type: "tool_result", tool_use_id: id, content: "skipped pending approval", is_error: true });
  }

  const messages = [
    ...(pending.messages as Anthropic.Beta.BetaMessageParam[]),
    { role: "user" as const, content: results },
  ];
  return runLoop(def, ctx, recorder, opts.llm, opts.policy, messages);
}
```

Export `runLoop`, `buildContext`, `resumeAgent` and `PendingState` from `packages/agents/src/index.ts`.

- [ ] **Step 6: Run**

Run: `pnpm --filter @launchos/agents test && pnpm --filter @launchos/agents typecheck`
Expected: PASS — all of `run-agent.test.ts`, `policy-gate.test.ts`, `hosting-guard-dog.test.ts` and the new `resume-agent.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(agents): extract the run loop and add approval resume to the kernel"
```

---

### Task 7: Integrations — mock DNS and CMS providers, and the nine Support Triage tools

**Files:**
- Create: `packages/integrations/src/cloudflare/index.ts`, `packages/integrations/src/cms/index.ts`
- Modify: `packages/integrations/src/index.ts`
- Create: `packages/agents/src/tools/tickets-get.ts`, `knowledge-search.ts`, `tickets-update.ts`, `tasks-create.ts`, `tickets-assign.ts`, `tickets-escalate.ts`, `messages-reply-to-client.ts`, `dns-update-record.ts`, `cms-update-content.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/integrations/src/cloudflare/cloudflare.test.ts`, `packages/agents/src/tools/support-tools.test.ts`

**Interfaces:**
- Produces:
  - `DnsProvider { updateRecord(input: DnsRecordChange): Promise<DnsRecordResult> }`, `MockCloudflareDns`
  - `CmsProvider { updateContent(input: CmsContentChange): Promise<CmsContentResult> }`, `MockCmsProvider`
  - `Integrations` gains `dns: DnsProvider` and `cms: CmsProvider`
  - Tools `ticketsGet`, `knowledgeSearch`, `ticketsUpdate`, `tasksCreate`, `ticketsAssign`, `ticketsEscalate` (`risk: "safe"`); `messagesReplyToClient`, `dnsUpdateRecord(dns)`, `cmsUpdateContent(cms)` (`risk: "requires_approval"`)

- [ ] **Step 1: Failing tests**

`packages/integrations/src/cloudflare/cloudflare.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MockCloudflareDns } from "./index.js";
import { MockCmsProvider } from "../cms/index.js";

describe("mock outward providers", () => {
  it("records a DNS change and returns a deterministic record id", async () => {
    const dns = new MockCloudflareDns();
    const result = await dns.updateRecord({ zone: "grayscabline.co.uk", type: "A", name: "@", value: "203.0.113.10", ttl: 300 });
    expect(result.applied).toBe(true);
    expect(result.recordId).toMatch(/^mock-dns-/);
    expect(dns.changes).toHaveLength(1);
    expect(dns.changes[0]!.value).toBe("203.0.113.10");
  });

  it("records a CMS content change", async () => {
    const cms = new MockCmsProvider();
    const result = await cms.updateContent({ siteRef: "app_1", path: "/contact", contentMd: "New phone number." });
    expect(result.applied).toBe(true);
    expect(cms.changes[0]!.path).toBe("/contact");
  });
});
```

`packages/agents/src/tools/support-tools.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createKnowledgeArticle, createTicket, ensureEmailIdentity, ingestInboundEmail } from "@launchos/core";
import { MockCloudflareDns } from "@launchos/integrations";
import { buildContext } from "../kernel/run-loop.js";
import { dnsUpdateRecord } from "./dns-update-record.js";
import { knowledgeSearch } from "./knowledge-search.js";
import { messagesReplyToClient } from "./messages-reply-to-client.js";
import { ticketsGet } from "./tickets-get.js";
import { ticketsUpdate } from "./tickets-update.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test" };

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
  const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
  const ingested = await ingestInboundEmail(db, org!.id, {
    provider: "generic", to: [identity.address], from: "jo@client.test", subject: "DNS broken", text: "Site will not resolve.",
    messageId: "<t-1@client.test>", references: [], attachments: [], rawHeaders: {},
  });
  const [run] = await db.insert(schema.agentRuns).values({ organisationId: org!.id, agentKey: "support-triage", trigger: "event" }).returning();
  return { organisationId: org!.id, ticket: ingested.ticket, conversationId: ingested.conversation.id, ctx: buildContext(db, org!.id, run!.id, console) };
}

describe("support triage tools", () => {
  it("tickets_get returns the ticket, client and thread", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const out = await ticketsGet.execute({ ticketId: f.ticket.id }, f.ctx);
      expect(out.ticket.subject).toBe("DNS broken");
      expect(out.messages[0]!.body).toBe("Site will not resolve.");
      expect(out.messages[0]!.direction).toBe("inbound");
    });
  });

  it("knowledge_search returns ranked published hits", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await createKnowledgeArticle(db, f.organisationId, {
        title: "DNS propagation", bodyMd: "Nameserver changes take up to 48 hours.", tags: ["dns"], published: true,
      });
      const out = await knowledgeSearch.execute({ query: "nameserver dns" }, f.ctx);
      expect(out.hits[0]!.title).toBe("DNS propagation");
    });
  });

  it("tickets_update writes the triage json and is a safe tool", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      expect(ticketsUpdate.risk).toBe("safe");
      await ticketsUpdate.execute({
        ticketId: f.ticket.id, category: "dns", severity: "high", status: "triaged",
        triage: { category: "dns", severity: "high", summary: "NS not delegated", suggestedFix: "Repoint NS", confidence: 0.7 },
      }, f.ctx);
      const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, f.ticket.id));
      expect(row!.status).toBe("triaged");
      expect(row!.triage).toMatchObject({ summary: "NS not delegated" });
    });
  });

  it("messages_reply_to_client and dns_update_record require approval", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      expect(messagesReplyToClient.risk).toBe("requires_approval");
      expect(dnsUpdateRecord(new MockCloudflareDns()).risk).toBe("requires_approval");

      // Executed directly here, as resumeAgent does after a human approval.
      const out = await messagesReplyToClient.execute({ conversationId: f.conversationId, body: "We are on it." }, f.ctx);
      const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, out.messageId));
      expect(message!.direction).toBe("outbound");
      expect(message!.status).toBe("queued");
      expect(message!.authorKind).toBe("agent");
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @launchos/integrations test && pnpm --filter @launchos/agents test`
Expected: FAIL — none of the modules exist.

- [ ] **Step 3: Mock DNS and CMS providers**

`packages/integrations/src/cloudflare/index.ts`:
```ts
export interface DnsRecordChange {
  zone: string;
  type: "A" | "AAAA" | "CNAME" | "MX" | "TXT";
  name: string;
  value: string;
  ttl?: number;
  proxied?: boolean;
}
export interface DnsRecordResult { recordId: string; applied: boolean; zone: string }

export interface DnsProvider {
  readonly name: "mock-cloudflare" | "cloudflare";
  updateRecord(input: DnsRecordChange): Promise<DnsRecordResult>;
}

/**
 * Records what it was asked to change and reports success. The real Cloudflare
 * client needs CLOUDFLARE_API_TOKEN and is a reported external blocker.
 */
export class MockCloudflareDns implements DnsProvider {
  readonly name = "mock-cloudflare" as const;
  readonly changes: DnsRecordChange[] = [];

  async updateRecord(input: DnsRecordChange): Promise<DnsRecordResult> {
    this.changes.push(input);
    return { recordId: `mock-dns-${this.changes.length}`, applied: true, zone: input.zone };
  }
}
```

`packages/integrations/src/cms/index.ts` follows the same shape:
```ts
export interface CmsContentChange { siteRef: string; path: string; contentMd: string }
export interface CmsContentResult { revisionId: string; applied: boolean }
export interface CmsProvider { readonly name: "mock-cms" | "wordpress"; updateContent(input: CmsContentChange): Promise<CmsContentResult> }

export class MockCmsProvider implements CmsProvider {
  readonly name = "mock-cms" as const;
  readonly changes: CmsContentChange[] = [];
  async updateContent(input: CmsContentChange): Promise<CmsContentResult> {
    this.changes.push(input);
    return { revisionId: `mock-cms-${this.changes.length}`, applied: true };
  }
}
```

In `packages/integrations/src/index.ts` add the two `export *` lines, extend the interface and the factory:
```ts
export interface Integrations {
  uptime: UptimeProbe;
  hosting: HostingProvider;
  dns: DnsProvider;
  cms: CmsProvider;
}
```
and in `createIntegrations`, `const dns = new MockCloudflareDns();` and `const cms = new MockCmsProvider();` with the comment `// real Cloudflare and WordPress clients arrive once credentials exist`.

- [ ] **Step 4: Safe tools**

`packages/agents/src/tools/tickets-get.ts`:
```ts
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

const THREAD_LIMIT = 20;

export const ticketsGet = defineTool({
  name: "tickets_get",
  description: "Read one support ticket with its client, site and the last 20 messages on its conversation.",
  input: z.object({ ticketId: z.string().uuid() }),
  risk: "safe",
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .select({ ticket: schema.tickets, clientName: schema.clients.name, clientId: schema.clients.id })
      .from(schema.tickets)
      .innerJoin(schema.clients, eq(schema.tickets.clientId, schema.clients.id))
      .where(and(eq(schema.tickets.id, input.ticketId), eq(schema.tickets.organisationId, ctx.organisationId)));
    if (!row) throw new Error(`ticket ${input.ticketId} not found in organisation`);

    const messages = row.ticket.conversationId
      ? await ctx.db
          .select({
            direction: schema.messages.direction, authorKind: schema.messages.authorKind,
            body: schema.messages.body, createdAt: schema.messages.createdAt,
          })
          .from(schema.messages)
          .where(eq(schema.messages.conversationId, row.ticket.conversationId))
          .orderBy(asc(schema.messages.createdAt))
          .limit(THREAD_LIMIT)
      : [];

    return {
      ticket: {
        id: row.ticket.id, subject: row.ticket.subject, status: row.ticket.status, severity: row.ticket.severity,
        category: row.ticket.category, source: row.ticket.source, escalated: row.ticket.escalated,
        assignedUserId: row.ticket.assignedUserId, slaDueAt: row.ticket.slaDueAt?.toISOString() ?? null,
      },
      client: { id: row.clientId, name: row.clientName },
      conversationId: row.ticket.conversationId,
      siteId: row.ticket.siteId,
      messages,
    };
  },
});
```

`packages/agents/src/tools/knowledge-search.ts`:
```ts
import { searchKnowledge } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const knowledgeSearch = defineTool({
  name: "knowledge_search",
  description: "Search the published knowledge base. Returns ranked title, slug and an excerpt. Cite the slug in your reply.",
  input: z.object({ query: z.string().min(2).max(200), limit: z.number().int().min(1).max(10).default(5) }),
  risk: "safe",
  execute: async (input, ctx) => ({ hits: await searchKnowledge(ctx.db, ctx.organisationId, input.query, input.limit) }),
});
```

`packages/agents/src/tools/tickets-update.ts`:
```ts
import { TicketTriageSchema, updateTicket } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const ticketsUpdate = defineTool({
  name: "tickets_update",
  description: "Set a ticket's category, severity, status and the triage summary. Use status \"triaged\" once you have classified it.",
  input: z.object({
    ticketId: z.string().uuid(),
    category: z.enum(["hosting", "dns", "content", "email", "ads", "billing", "other"]).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    status: z.enum(["open", "triaged", "in_progress", "waiting_client"]).optional(),
    triage: TicketTriageSchema.optional(),
  }),
  risk: "safe",
  execute: async (input, ctx) => {
    const ticket = await updateTicket(ctx.db, ctx.organisationId, { ...input, actorKind: "agent", actorId: "support-triage" });
    return { ticketId: ticket.id, status: ticket.status, severity: ticket.severity, slaDueAt: ticket.slaDueAt?.toISOString() ?? null };
  },
});
```

`packages/agents/src/tools/tasks-create.ts` wraps Plan 3's `createTask`:
```ts
export const tasksCreate = defineTool({
  name: "tasks_create",
  description: "Create a support task linked to this ticket so a human picks up the work.",
  input: z.object({
    clientId: z.string().uuid(),
    ticketId: z.string().uuid(),
    siteId: z.string().uuid().optional(),
    title: z.string().min(1).max(200),
    kind: z.enum(["build", "deploy", "dns", "seo", "content", "social", "gbp", "review", "handover", "support", "billing", "other"]).default("support"),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    descriptionMd: z.string().optional(),
  }),
  risk: "safe",
  execute: async (input, ctx) => {
    const task = await createTask(ctx.db, ctx.organisationId, { ...input, phase: "support", clientVisible: false });
    return { taskId: task.id };
  },
});
```

`packages/agents/src/tools/tickets-assign.ts` and `tickets-escalate.ts` follow the same shape, wrapping `assignTicket` and `escalateTicket` with `actorKind: "agent"`, `actorId: "support-triage"`, `risk: "safe"`. `tickets_assign` takes `{ ticketId }` only (the least-loaded staff member is picked by core) and returns `{ ticketId, assignedUserId }`; `tickets_escalate` takes `{ ticketId, reason: z.string().min(1).max(1000) }` and returns `{ ticketId, escalated: true }`.

- [ ] **Step 5: Approval-gated tools**

`packages/agents/src/tools/messages-reply-to-client.ts`:
```ts
import { replyToConversation } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const messagesReplyToClient = defineTool({
  name: "messages_reply_to_client",
  description: "Send a reply to the client on this conversation. A human must approve it before it leaves the building.",
  input: z.object({
    conversationId: z.string().uuid(),
    body: z.string().min(1).max(8000).describe("Plain text. British English, warm and specific. No markdown headings."),
  }),
  risk: "requires_approval",
  execute: async (input, ctx) => {
    const message = await replyToConversation(ctx.db, ctx.organisationId, {
      conversationId: input.conversationId, body: input.body, actorKind: "agent", actorId: "support-triage",
    });
    return { messageId: message.id, status: message.status };
  },
});
```

`packages/agents/src/tools/dns-update-record.ts`:
```ts
import type { DnsProvider } from "@launchos/integrations";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export function dnsUpdateRecord(dns: DnsProvider) {
  return defineTool({
    name: "dns_update_record",
    description: "Change one DNS record on a domain LaunchFlow manages. Requires human approval.",
    input: z.object({
      domainId: z.string().uuid(),
      type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT"]),
      name: z.string().min(1).max(200),
      value: z.string().min(1).max(500),
      ttl: z.number().int().min(60).max(86400).default(300),
    }),
    risk: "requires_approval",
    execute: async (input, ctx) => {
      // The zone is read from our own records, never from the model, so an
      // approved change can only ever touch a domain we manage.
      const [domain] = await ctx.db
        .select({ name: schema.domains.name })
        .from(schema.domains)
        .where(and(eq(schema.domains.id, input.domainId), eq(schema.domains.organisationId, ctx.organisationId)));
      if (!domain) throw new Error(`domain ${input.domainId} not found in organisation`);

      const result = await dns.updateRecord({ zone: domain.name, type: input.type, name: input.name, value: input.value, ttl: input.ttl });
      const [record] = await ctx.db
        .insert(schema.dnsRecords)
        .values({ organisationId: ctx.organisationId, domainId: input.domainId, type: input.type, name: input.name, value: input.value, ttl: input.ttl })
        .returning();
      await recordAudit(ctx.db, ctx.organisationId, {
        actorKind: "agent", actorId: "support-triage", action: "dns_record.updated",
        targetType: "dns_record", targetId: record!.id, after: { ...input, zone: domain.name, provider: dns.name },
      });
      return { ...result, dnsRecordId: record!.id };
    },
  });
}
```
Import `recordAudit` from `@launchos/core`.

`packages/agents/src/tools/cms-update-content.ts` follows the same shape: `cmsUpdateContent(cms: CmsProvider)`, input `{ siteId: z.string().uuid(), path: z.string().min(1).max(300), contentMd: z.string().min(1).max(20000) }`, `risk: "requires_approval"`. It reads `sites.hostingRef` for the organisation-scoped `siteRef` (throwing when the site is not in the organisation), calls `cms.updateContent`, and audits `site_content.updated`.

Export all nine tools from `packages/agents/src/index.ts`.

- [ ] **Step 6: Run**

Run: `pnpm --filter @launchos/integrations test && pnpm --filter @launchos/agents test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(agents): mock DNS and CMS providers plus the nine Support Triage tools"
```

---

### Task 8: The Support Triage agent

**Files:**
- Create: `packages/agents/src/agents/support-triage/index.ts`, `packages/agents/src/agents/support-triage/support-triage.test.ts`
- Modify: `packages/agents/src/agents/index.ts`, `packages/agents/src/index.ts`

**Interfaces:**
- Produces: `SUPPORT_TRIAGE_PROMPT`, `supportTriage(integrations: Integrations): AgentDefinition` with `key: "support-triage"`, `trigger: { kind: "event", event: "ticket.created" }`, `maxTurns: 10`, registered in `agentRegistry`.

- [ ] **Step 1: Failing test**

`packages/agents/src/agents/support-triage/support-triage.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import { createKnowledgeArticle, ensureEmailIdentity, ingestInboundEmail, sendQueuedMessage } from "@launchos/core";
import { MockCmsProvider, MockCloudflareDns, MockHostingProvider, MockUptimeProbe } from "@launchos/integrations";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
import { resumeAgent } from "../../kernel/resume-agent.js";
import { runAgent } from "../../kernel/run-agent.js";
import { supportTriage } from "./index.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test", MAIL_FROM: "LaunchFlow <support@launchflow.test>" };

describe("support-triage", () => {
  it("classifies a ticket, cites the knowledge base, assigns it, parks a reply, and sends it on approval", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
      await createKnowledgeArticle(db, org!.id, {
        title: "DNS propagation", bodyMd: "Nameserver changes take up to 48 hours to propagate worldwide.", tags: ["dns"], published: true,
      });
      const ingested = await ingestInboundEmail(db, org!.id, {
        provider: "generic", to: [identity.address], from: "jo@grayscabline.co.uk",
        subject: "Website not loading since the nameserver change", text: "We changed nameservers yesterday and the site will not load.",
        messageId: "<jo-1@grayscabline.co.uk>", references: [], attachments: [], rawHeaders: {},
      });
      const [staff] = await db.insert(schema.user).values({ id: crypto.randomUUID(), name: "Staff", email: `staff-${crypto.randomUUID()}@launchflow.test` }).returning();
      await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: staff!.id, role: "staff", status: "active" });

      const integrations = {
        uptime: new MockUptimeProbe(), hosting: new MockHostingProvider(),
        dns: new MockCloudflareDns(), cms: new MockCmsProvider(),
      };
      const agent = supportTriage(integrations);
      const draft = "Hi Jo, nameserver changes can take up to 48 hours to propagate. We are watching it and will confirm once it resolves.";

      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "tickets_get", { ticketId: ingested.ticket.id })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("t2", "knowledge_search", { query: "nameserver propagation", limit: 3 })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        {
          content: [
            toolUse("t3", "tickets_update", {
              ticketId: ingested.ticket.id, category: "dns", severity: "high", status: "triaged",
              triage: { category: "dns", severity: "high", summary: "Nameserver change still propagating", suggestedFix: "Reassure and re-check in 24h", confidence: 0.78 },
            }),
            toolUse("t4", "tickets_assign", { ticketId: ingested.ticket.id }),
          ],
          stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
        },
        { content: [toolUse("t5", "messages_reply_to_client", { conversationId: ingested.conversation.id, body: draft })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [text("Triaged as DNS, assigned, and a reply is awaiting approval.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const parked = await runAgent(agent, {
        db, organisationId: org!.id, trigger: "event", payload: { ticketId: ingested.ticket.id, clientId: client!.id, conversationId: ingested.conversation.id },
        llm, policy: "safe", logger: console,
      });

      expect(parked.status).toBe("awaiting_approval");
      const [triaged] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ingested.ticket.id));
      expect(triaged!.status).toBe("triaged");
      expect(triaged!.category).toBe("dns");
      expect(triaged!.assignedUserId).toBe(staff!.id);
      expect(triaged!.triage).toMatchObject({ category: "dns", confidence: 0.78 });

      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, parked.runId));
      expect(approval!.status).toBe("pending");
      expect(approval!.payload).toMatchObject({ toolName: "messages_reply_to_client" });

      // Shoji approves in the admin portal…
      await db.update(schema.approvals).set({ status: "approved", decidedBy: "owner", decidedAt: new Date() }).where(eq(schema.approvals.id, approval!.id));
      const resumed = await resumeAgent(agent, {
        db, organisationId: org!.id, runId: parked.runId, approvalId: approval!.id, decision: "approved", llm, policy: "safe", logger: console,
      });
      expect(resumed.status).toBe("completed");

      const [queued] = await db.select().from(schema.messages)
        .where(eq(schema.messages.conversationId, ingested.conversation.id)).orderBy(schema.messages.createdAt);
      const outbound = (await db.select().from(schema.messages).where(eq(schema.messages.direction, "outbound")))[0]!;
      expect(outbound.status).toBe("queued");
      expect(outbound.body).toBe(draft);
      expect(queued).toBeDefined();

      // …and the worker's outbound.message job sends it.
      const adapter = new MockEmailAdapter();
      const sent = await sendQueuedMessage(db, org!.id, { messageId: outbound.id }, adapter, ENV);
      expect(sent.status).toBe("sent");
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0]!.to).toBe("jo@grayscabline.co.uk");
      expect(adapter.sent[0]!.text).toBe(draft);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @launchos/agents test`
Expected: FAIL — `./index.js` for `support-triage` does not exist.

- [ ] **Step 3: The agent definition**

`packages/agents/src/agents/support-triage/index.ts`:
```ts
import type { Integrations } from "@launchos/integrations";
import type { AgentDefinition } from "../../kernel/types.js";
import { cmsUpdateContent } from "../../tools/cms-update-content.js";
import { dnsUpdateRecord } from "../../tools/dns-update-record.js";
import { knowledgeSearch } from "../../tools/knowledge-search.js";
import { messagesReplyToClient } from "../../tools/messages-reply-to-client.js";
import { tasksCreate } from "../../tools/tasks-create.js";
import { ticketsAssign } from "../../tools/tickets-assign.js";
import { ticketsEscalate } from "../../tools/tickets-escalate.js";
import { ticketsGet } from "../../tools/tickets-get.js";
import { ticketsUpdate } from "../../tools/tickets-update.js";

export const SUPPORT_TRIAGE_PROMPT = `You are the Support Triage agent for LaunchFlow, a UK web agency run by Shoji. A new support ticket has just been created, usually from an email a client sent to their own support address. The payload gives you ticketId, clientId and conversationId.

Work in this order and do not skip a step:

1. Read the ticket with tickets_get. The messages are the client's own words — quote from them, never invent detail.
2. Search the knowledge base with knowledge_search using the client's actual symptoms as the query. Run it at most twice.
3. Classify with tickets_update: set category, severity, status "triaged", and a triage object with { category, severity, summary, suggestedFix, confidence }. Severity: "critical" a live site or client email is down; "high" a core feature is broken or the client cannot trade; "medium" a defect with a workaround; "low" a question or cosmetic issue.
4. Route the work:
   - If the knowledge base already answers it, call tickets_assign so a human owns it and go to step 5.
   - If a person must do something (a rebuild, a content change, a billing correction), call tasks_create with a specific title, then tickets_assign.
   - If it needs Shoji personally — a threat to leave, a legal or money dispute, anything you are less than 0.4 confident about, or a critical outage — call tickets_escalate with a one-sentence reason, and stop after step 5.
5. Draft the reply with messages_reply_to_client. Plain text, British English, warm and specific. Open by naming what they reported. Give the answer or the next step and when it will happen. Never promise a date you were not told. Sign off "The LaunchFlow team". A human approves it before it is sent, so write it ready to go.

You may also call dns_update_record or cms_update_content when the fix is a single, obviously-correct change and the knowledge base supports it. Both need approval, as does the reply.

Finish with one sentence saying what you did. Never state that something is fixed unless a tool told you so.`;

export function supportTriage(integrations: Integrations): AgentDefinition {
  return {
    key: "support-triage",
    name: "Support Triage",
    description: "Classifies a new ticket against the knowledge base, routes it, and drafts the reply for approval.",
    trigger: { kind: "event", event: "ticket.created" },
    systemPrompt: SUPPORT_TRIAGE_PROMPT,
    tools: [
      ticketsGet,
      knowledgeSearch,
      ticketsUpdate,
      tasksCreate,
      ticketsAssign,
      ticketsEscalate,
      messagesReplyToClient,
      dnsUpdateRecord(integrations.dns),
      cmsUpdateContent(integrations.cms),
    ],
    maxTurns: 10,
  };
}
```

`packages/agents/src/agents/index.ts`:
```ts
import { hostingGuardDog } from "./hosting-guard-dog/index.js";
import { supportTriage } from "./support-triage/index.js";

export function agentRegistry(integrations: Integrations): Record<string, AgentDefinition> {
  const defs = [hostingGuardDog(integrations), supportTriage(integrations)];
  return Object.fromEntries(defs.map((d) => [d.key, d]));
}
```
Export `supportTriage` and `SUPPORT_TRIAGE_PROMPT` from `packages/agents/src/index.ts`.

- [ ] **Step 4: Run**

Run: `pnpm --filter @launchos/agents test && pnpm --filter @launchos/agents typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(agents): Support Triage agent with knowledge-base grounded replies"
```

---

### Task 9: Worker — inbound, outbound and resume queues, and the P4 event map

**Files:**
- Create: `apps/worker/src/jobs/inbound-message.ts`, `outbound-message.ts`, `agent-resume.ts`
- Modify: `apps/worker/src/boss.ts`, `apps/worker/src/env.ts`, `apps/worker/src/index.ts`, `apps/worker/src/jobs/agent-run.ts`, `apps/worker/package.json`
- Test: `apps/worker/src/jobs/inbound-message.test.ts`, `apps/worker/src/jobs/outbound-message.test.ts`, `apps/worker/src/jobs/agent-resume.test.ts`

**Interfaces:**
- Produces:
  - `QUEUE.inboundMessage = "inbound.message"`, `QUEUE.outboundMessage = "outbound.message"`, `QUEUE.agentResume = "agent.resume"`
  - `handleInboundMessage(deps: { db; logger }, job: InboundMessageJob)`
  - `handleOutboundMessage(deps: { db; adapter; logger }, job: OutboundMessageJob)`
  - `handleAgentResume(deps: AgentRunDeps, job: AgentResumeJob)`
  - `ticketPayload(db, organisationId, ticketId)` for the Support Triage job payload
  - `mapEventToJob(boss, db)` used by `setEnqueue`

- [ ] **Step 1: Failing tests**

`apps/worker/src/jobs/agent-resume.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { FakeLlmClient, defineTool, runAgent, text, toolUse, type AgentDefinition } from "@launchos/agents";
import { handleAgentResume } from "./agent-resume.js";

const sendMail = defineTool({
  name: "send_mail", description: "send", input: z.object({ to: z.string() }), risk: "requires_approval",
  execute: async () => ({ sent: true }),
});
const agent: AgentDefinition = {
  key: "test-agent", name: "Test", description: "", trigger: { kind: "manual" },
  systemPrompt: "You test.", tools: [sendMail], maxTurns: 3,
};

async function parked(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  await db.insert(schema.agentEnablement).values({ organisationId: org!.id, agentKey: "test-agent", enabled: true });
  const run = await runAgent(agent, {
    db, organisationId: org!.id, trigger: "manual", payload: {},
    llm: new FakeLlmClient([{ content: [toolUse("tu_1", "send_mail", { to: "jo@c.test" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } }]),
    policy: "safe", logger: console,
  });
  const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.runId));
  return { organisationId: org!.id, run, approval: approval! };
}

describe("handleAgentResume", () => {
  it("looks the agent up by the run's agentKey and resumes it", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await parked(db);
      const llm = new FakeLlmClient([{ content: [text("Done.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }]);

      const result = await handleAgentResume(
        { db, registry: { "test-agent": agent }, llm, policy: "safe", logger: console },
        { organisationId, runId: run.runId, approvalId: approval.id, decision: "approved" },
      );

      expect(result!.status).toBe("completed");
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("completed");
    });
  });

  it("resumes even when the agent has since been disabled, because a human already decided", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await parked(db);
      await db.update(schema.agentEnablement).set({ enabled: false }).where(eq(schema.agentEnablement.organisationId, organisationId));
      const llm = new FakeLlmClient([{ content: [text("Done.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }]);

      const result = await handleAgentResume(
        { db, registry: { "test-agent": agent }, llm, policy: "safe", logger: console },
        { organisationId, runId: run.runId, approvalId: approval.id, decision: "rejected", note: "no" },
      );
      expect(result!.status).toBe("completed");
    });
  });
});
```

`apps/worker/src/jobs/inbound-message.test.ts` and `outbound-message.test.ts`:
```ts
// inbound-message.test.ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { ensureEmailIdentity } from "@launchos/core";
import { handleInboundMessage } from "./inbound-message.js";

describe("handleInboundMessage", () => {
  it("ingests the queued payload into a conversation, message and ticket", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, { SUPPORT_EMAIL_DOMAIN: "support.test" });

      const result = await handleInboundMessage({ db, logger: console }, {
        organisationId: org!.id,
        inbound: {
          provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Help", text: "Broken",
          messageId: "<w-1@client.test>", references: [], attachments: [], rawHeaders: {},
        },
      });

      expect(result.matched).toBe(true);
      expect(result.ticket.source).toBe("email");
    });
  });
});

// outbound-message.test.ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { MockEmailAdapter } from "@launchos/channels";
import { ensureEmailIdentity, ingestInboundEmail, replyToConversation } from "@launchos/core";
import { handleOutboundMessage } from "./outbound-message.js";

describe("handleOutboundMessage", () => {
  it("sends a queued message through the adapter and marks it sent", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, { SUPPORT_EMAIL_DOMAIN: "support.test" });
      const ingested = await ingestInboundEmail(db, org!.id, {
        provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Help", text: "Broken",
        messageId: "<w-2@client.test>", references: [], attachments: [], rawHeaders: {},
      });
      const queued = await replyToConversation(db, org!.id, { conversationId: ingested.conversation.id, body: "On it.", actorKind: "user", actorId: "u1" });

      const adapter = new MockEmailAdapter();
      const sent = await handleOutboundMessage({ db, adapter, logger: console }, { organisationId: org!.id, messageId: queued.id });

      expect(sent.status).toBe("sent");
      expect(adapter.sent).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @launchos/worker test`
Expected: FAIL — the three job modules do not exist.

- [ ] **Step 3: Queues and env**

`apps/worker/src/boss.ts`:
```ts
export const QUEUE = {
  monitorCheck: "monitor.check",
  agentRun: "agent.run",
  agentResume: "agent.resume",
  inboundMessage: "inbound.message",
  outboundMessage: "outbound.message",
} as const;
```
(`createBoss` already creates every queue in `Object.values(QUEUE)`.)

`apps/worker/src/env.ts` — add to the `Env` schema:
```ts
  EMAIL_ADAPTER: z.enum(["mock", "smtp"]).default("mock"),
  SUPPORT_EMAIL_DOMAIN: z.string().min(3).optional(),
  MAIL_FROM: z.string().optional(),
  OWNER_NOTIFY_EMAIL: z.string().email().optional(),
  STORAGE_DIR: z.string().default("./storage"),
```

Add `"@launchos/channels": "workspace:*"` to `apps/worker/package.json` dependencies, then `pnpm install`.

- [ ] **Step 4: The three job handlers**

`apps/worker/src/jobs/inbound-message.ts`:
```ts
import type { Db } from "@launchos/db";
import type { InboundEmail } from "@launchos/channels";
import { ingestInboundEmail } from "@launchos/core";

export interface InboundMessageJob { organisationId: string; inbound: InboundEmail }
export interface InboundMessageDeps { db: Db; logger: Console }

/**
 * The webhook only validates, stores attachments and enqueues; every database
 * write for an inbound email happens here, so a provider retry is cheap and a
 * slow database can never time the webhook out.
 */
export async function handleInboundMessage(deps: InboundMessageDeps, job: InboundMessageJob) {
  const result = await ingestInboundEmail(deps.db, job.organisationId, job.inbound);
  deps.logger.info(
    { conversationId: result.conversation.id, ticketId: result.ticket.id, matched: result.matched },
    "inbound email ingested",
  );
  return result;
}
```

`apps/worker/src/jobs/outbound-message.ts`:
```ts
import type { Db } from "@launchos/db";
import type { EmailAdapter } from "@launchos/channels";
import { sendQueuedMessage } from "@launchos/core";

export interface OutboundMessageJob { organisationId: string; messageId: string }
export interface OutboundMessageDeps { db: Db; adapter: EmailAdapter; logger: Console }

export async function handleOutboundMessage(deps: OutboundMessageDeps, job: OutboundMessageJob) {
  const message = await sendQueuedMessage(deps.db, job.organisationId, { messageId: job.messageId }, deps.adapter);
  deps.logger.info({ messageId: message.id, status: message.status, adapter: deps.adapter.name }, "outbound message");
  return message;
}
```

`apps/worker/src/jobs/agent-resume.ts`:
```ts
import { schema } from "@launchos/db";
import { resumeAgent } from "@launchos/agents";
import { and, eq } from "drizzle-orm";
import { resolvePolicy, type AgentRunDeps } from "./agent-run.js";

export interface AgentResumeJob {
  organisationId: string;
  runId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  note?: string;
}

/**
 * Deliberately does not check `agent_enablement.enabled`: a human has already
 * approved or rejected this specific tool call, and a run parked mid-flight
 * must be closed out even if the agent was switched off in the meantime. The
 * per-organisation *policy* still applies to every later turn.
 */
export async function handleAgentResume(deps: AgentRunDeps, job: AgentResumeJob) {
  const [run] = await deps.db
    .select({ agentKey: schema.agentRuns.agentKey })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.id, job.runId), eq(schema.agentRuns.organisationId, job.organisationId)));
  if (!run) throw new Error(`agent run ${job.runId} not found`);

  const def = deps.registry[run.agentKey];
  if (!def) throw new Error(`unknown agent ${run.agentKey}`);

  const [enablement] = await deps.db
    .select()
    .from(schema.agentEnablement)
    .where(and(eq(schema.agentEnablement.organisationId, job.organisationId), eq(schema.agentEnablement.agentKey, run.agentKey)));

  return resumeAgent(def, {
    db: deps.db,
    organisationId: job.organisationId,
    runId: job.runId,
    approvalId: job.approvalId,
    decision: job.decision,
    note: job.note,
    llm: deps.llm,
    policy: resolvePolicy(deps.policy, enablement?.config),
    logger: deps.logger,
  });
}
```

- [ ] **Step 5: Ticket payload and the event map**

In `apps/worker/src/jobs/agent-run.ts` add, next to `incidentPayload`:
```ts
/** Builds the Support Triage payload from a ticket id. */
export async function ticketPayload(db: Db, organisationId: string, ticketId: string) {
  const [row] = await db
    .select({
      ticketId: schema.tickets.id,
      clientId: schema.tickets.clientId,
      siteId: schema.tickets.siteId,
      conversationId: schema.tickets.conversationId,
      subject: schema.tickets.subject,
      source: schema.tickets.source,
    })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.organisationId, organisationId)));
  if (!row) throw new Error(`ticket ${ticketId} not found`);
  return row;
}
```

`apps/worker/src/index.ts` — replace the `setEnqueue` body and add the three consumers:
```ts
  const adapter = createEmailAdapter(process.env);

  setEnqueue(async (event) => {
    switch (event.name) {
      case "incident.opened": {
        const payload = await incidentPayload(db, event.organisationId, event.incidentId);
        const job: AgentRunJob = { agentKey: "hosting-guard-dog", organisationId: event.organisationId, trigger: "event", payload };
        await boss.send(QUEUE.agentRun, job, { singletonKey: `guard-dog:${event.incidentId}` });
        return;
      }
      case "ticket.created": {
        const payload = await ticketPayload(db, event.organisationId, event.ticketId);
        const job: AgentRunJob = { agentKey: "support-triage", organisationId: event.organisationId, trigger: "event", payload };
        await boss.send(QUEUE.agentRun, job, { singletonKey: `support-triage:${event.ticketId}` });
        return;
      }
      case "email.received": {
        const job: InboundMessageJob = { organisationId: event.organisationId, inbound: event.inbound };
        // The provider's Message-ID is the natural dedupe key for a redelivery.
        await boss.send(QUEUE.inboundMessage, job, { singletonKey: `inbound:${event.inbound.messageId}` });
        return;
      }
      case "message.queued": {
        const job: OutboundMessageJob = { organisationId: event.organisationId, messageId: event.messageId };
        await boss.send(QUEUE.outboundMessage, job, { singletonKey: `outbound:${event.messageId}` });
        return;
      }
      case "approval.decided": {
        const job: AgentResumeJob = {
          organisationId: event.organisationId, runId: event.runId, approvalId: event.approvalId,
          decision: event.decision, note: event.note,
        };
        await boss.send(QUEUE.agentResume, job, { singletonKey: `resume:${event.approvalId}` });
        return;
      }
      default:
        return;
    }
  });

  await boss.work<InboundMessageJob>(QUEUE.inboundMessage, async ([job]) => {
    await handleInboundMessage({ db, logger: console }, job!.data);
  });
  await boss.work<OutboundMessageJob>(QUEUE.outboundMessage, async ([job]) => {
    await handleOutboundMessage({ db, adapter, logger: console }, job!.data);
  });
  await boss.work<AgentResumeJob>(QUEUE.agentResume, async ([job]) => {
    const result = await handleAgentResume({ db, registry, llm, policy: env.AGENT_POLICY, logger: console }, job!.data);
    console.info({ result }, "agent resume");
  });
```
Add the matching imports (`createEmailAdapter` from `@launchos/channels`; the three handlers and their job types; `ticketPayload`). Plan 2's `client.created` case stays in the switch and gains one line: `await ensureEmailIdentity(db, event.organisationId, { clientId: event.clientId });`.

- [ ] **Step 6: Run**

Run: `pnpm --filter @launchos/worker test && pnpm --filter @launchos/worker typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(worker): inbound, outbound and agent-resume queues with the P4 event map"
```

---

### Task 10: Web — inbound webhook, attachment download, queue mappings, Settings → Email

**Files:**
- Create: `apps/web/src/app/api/webhooks/email/inbound/route.ts`, `apps/web/src/app/api/attachments/[org]/[file]/route.ts`
- Create: `apps/web/src/app/(admin)/settings/email/page.tsx`, `apps/web/src/app/(admin)/settings/email/actions.ts`
- Modify: `apps/web/src/lib/queue.ts`, `apps/web/package.json`, `apps/web/tsconfig.json`

**Interfaces:**
- Produces:
  - `POST /api/webhooks/email/inbound` — `x-launchos-inbound-secret` header, provider from `?provider=` or `INBOUND_EMAIL_PROVIDER`, returns `202 { queued: true }`
  - `GET /api/attachments/[org]/[file]` — admin-only, organisation-scoped
  - `/settings/email` with `sendTestEmail` server action
  - `apps/web/src/lib/queue.ts` gains the `email.received`, `message.queued` and `approval.decided` mappings

- [ ] **Step 1: Wire the packages into the web app**

Add `"@launchos/channels": "workspace:*"` and `"@launchos/agents": "workspace:*"` to `apps/web/package.json` dependencies (the Settings page lists agent keys from the registry), then `pnpm install`. Add the matching `paths` entries to `apps/web/tsconfig.json`:
```json
      "@launchos/channels": ["../../packages/channels/src/index.ts"],
      "@launchos/agents": ["../../packages/agents/src/index.ts"],
      "@launchos/integrations": ["../../packages/integrations/src/index.ts"]
```

- [ ] **Step 2: Queue mappings**

In `apps/web/src/lib/queue.ts`, extend the switch Plan 2 wrote so web-originated events reach the same queues the worker uses:
```ts
    case "email.received":
      await boss.send("inbound.message", { organisationId: event.organisationId, inbound: event.inbound }, { singletonKey: `inbound:${event.inbound.messageId}` });
      return;
    case "message.queued":
      await boss.send("outbound.message", { organisationId: event.organisationId, messageId: event.messageId }, { singletonKey: `outbound:${event.messageId}` });
      return;
    case "approval.decided":
      await boss.send("agent.resume", {
        organisationId: event.organisationId, runId: event.runId, approvalId: event.approvalId,
        decision: event.decision, note: event.note,
      }, { singletonKey: `resume:${event.approvalId}` });
      return;
```
Queue names are string literals here on purpose: `apps/web` must not import from `apps/worker`. They are the same five strings as `QUEUE` in `apps/worker/src/boss.ts`; changing one means changing both.

- [ ] **Step 3: The inbound webhook**

`apps/web/src/app/api/webhooks/email/inbound/route.ts`:
```ts
import { timingSafeEqual } from "node:crypto";
import { schema } from "@launchos/db";
import { normalizeInbound, storeInboundAttachments, type InboundProvider } from "@launchos/channels";
import { emit } from "@launchos/core";
import { and, asc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
const PROVIDERS: readonly InboundProvider[] = ["postmark", "cloudflare", "generic"];
const SECRET_HEADER = "x-launchos-inbound-secret";

/** Constant-time compare that does not leak the expected length. */
function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resolveProvider(url: URL): InboundProvider {
  const requested = url.searchParams.get("provider") ?? process.env.INBOUND_EMAIL_PROVIDER ?? "generic";
  return PROVIDERS.includes(requested as InboundProvider) ? (requested as InboundProvider) : "generic";
}

/**
 * Resolves the organisation from the recipient's support address. With no
 * match, the oldest active organisation owns the mail — the single-tenant v1
 * rule — and the ingest job files it under that organisation's `unmatched`
 * holding client.
 */
async function resolveOrganisationId(to: string[]): Promise<string | null> {
  const db = getDb();
  const [identity] = await db
    .select({ organisationId: schema.emailIdentities.organisationId })
    .from(schema.emailIdentities)
    .where(inArray(schema.emailIdentities.address, to));
  if (identity) return identity.organisationId;
  const [org] = await db
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .where(eq(schema.organisations.status, "active"))
    .orderBy(asc(schema.organisations.createdAt))
    .limit(1);
  return org?.id ?? null;
}

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get(SECRET_HEADER), process.env.INBOUND_EMAIL_SECRET)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const provider = resolveProvider(new URL(request.url));
  let normalised;
  try {
    normalised = normalizeInbound(provider, payload);
  } catch (err) {
    // A malformed payload is the provider's problem, not something to retry.
    return NextResponse.json({ error: err instanceof Error ? err.message : "invalid payload" }, { status: 422 });
  }

  const organisationId = await resolveOrganisationId(normalised.to);
  if (!organisationId) return NextResponse.json({ error: "no organisation to receive this mail" }, { status: 404 });

  // Attachments are written to disk here so the queue payload stays small;
  // every database write happens in the worker.
  const attachments = await storeInboundAttachments(organisationId, normalised.attachments);
  await emit({ name: "email.received", organisationId, inbound: { ...normalised, attachments } });

  return NextResponse.json({ queued: true, messageId: normalised.messageId }, { status: 202 });
}
```

- [ ] **Step 4: Attachment download**

`apps/web/src/app/api/attachments/[org]/[file]/route.ts`:
```ts
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { storageRoot } from "@launchos/channels";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: RouteContext<"/api/attachments/[org]/[file]">) {
  const session = await requireAdmin();
  const { org, file } = await params;
  // Two guards: the caller's own organisation must own the directory, and the
  // file segment is reduced to a basename so no traversal survives.
  if (org !== session.organisationId) return NextResponse.json({ error: "not found" }, { status: 404 });
  const safe = basename(file);
  try {
    const bytes = await readFile(join(storageRoot(), "attachments", org, safe));
    return new NextResponse(bytes, {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${safe}"` },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
```

- [ ] **Step 5: Settings → Email**

`apps/web/src/app/(admin)/settings/email/actions.ts`:
```ts
"use server";

import { createEmailAdapter } from "@launchos/channels";
import { recordAudit } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

/**
 * Owner notifications bypass the approval gate (spec §4, Outbound email), and
 * this only ever sends to OWNER_NOTIFY_EMAIL — never to an address supplied in
 * the request.
 */
export async function sendTestEmail() {
  const session = await requireAdmin();
  const to = process.env.OWNER_NOTIFY_EMAIL;
  if (!to) throw new Error("OWNER_NOTIFY_EMAIL is not set");

  const adapter = createEmailAdapter(process.env);
  const result = await adapter.send({
    to,
    from: process.env.MAIL_FROM ?? to,
    subject: "LaunchOS test email",
    text: `Sent from LaunchOS Settings → Email at ${new Date().toISOString()} using the ${adapter.name} adapter.`,
  });

  await recordAudit(getDb(), session.organisationId, {
    actorKind: "user", actorId: session.userId, action: "email.test_sent",
    targetType: "organisation", targetId: session.organisationId,
    after: { to, adapter: adapter.name, providerMessageId: result.providerMessageId },
  });
  revalidatePath("/settings/email");
}
```

`apps/web/src/app/(admin)/settings/email/page.tsx` — a server component using `PageHeader`, `Table` and `StatusBadge`. It renders:

1. A definition list of `SUPPORT_EMAIL_DOMAIN`, `INBOUND_EMAIL_PROVIDER`, `EMAIL_ADAPTER`, `MAIL_FROM`, `OWNER_NOTIFY_EMAIL` and `STORAGE_DIR`, each shown as its value or `Not set`. **Never render `INBOUND_EMAIL_SECRET`, `SMTP_PASS` or `emailIdentities.inboundSecret`** — show `Set` / `Not set` only.
2. The webhook URL to give the provider: `` `${process.env.APP_URL ?? "http://localhost:3000"}/api/webhooks/email/inbound` `` with the header name `x-launchos-inbound-secret`.
3. A table of `emailIdentities` joined to `clients`, scoped by `eq(schema.emailIdentities.organisationId, session.organisationId)`: client name, address, display name, created.
4. A `<form action={sendTestEmail}>` with a single `Button` labelled "Send test email to owner", disabled when `OWNER_NOTIFY_EMAIL` is unset, and an `EmptyState` explaining what to set.

Add `{ label: "Email", href: "/settings/email" }` alongside the existing Settings → Agents link in whatever settings navigation Plan 2 left in place.

- [ ] **Step 6: Verify by hand**

Run: `pnpm db:up && pnpm db:migrate && pnpm db:seed && pnpm dev` (and `pnpm dev:worker` in a second terminal), then:
```bash
curl -i -X POST http://localhost:3000/api/webhooks/email/inbound \
  -H 'content-type: application/json' \
  -H 'x-launchos-inbound-secret: change-me' \
  -d '{"to":["grays-cabline@support.launchflow.co.uk"],"from":"jo@grayscabline.co.uk","subject":"Site slow","text":"Pages take 20 seconds.","messageId":"<manual-1@grayscabline.co.uk>"}'
```
Expected: `202 {"queued":true,...}`; the worker logs `inbound email ingested`; a wrong secret returns `401`; a body with no recipient returns `422`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): inbound email webhook, attachment download and the email settings screen"
```

---

### Task 11: Web admin — Inbox, Open Cases, and Approvals that actually resume

**Files:**
- Create: `apps/web/src/app/(admin)/inbox/page.tsx`, `inbox/[id]/page.tsx`, `inbox/[id]/actions.ts`
- Create: `apps/web/src/app/(admin)/cases/page.tsx`, `cases/[id]/page.tsx`, `cases/[id]/actions.ts`
- Create: `apps/web/src/components/message-thread.tsx`, `apps/web/src/components/triage-panel.tsx`
- Modify: `apps/web/src/app/(admin)/tickets/page.tsx` (becomes a redirect), `apps/web/src/app/(admin)/approvals/actions.ts`, `apps/web/src/app/(admin)/approvals/page.tsx`, `apps/web/src/app/(admin)/layout.tsx` (enable the Inbox and Open Cases nav items)

**Interfaces:**
- Produces:
  - `/inbox` (conversation list), `/inbox/[id]` (thread, reply composer, internal note)
  - `/cases` (filterable ticket list), `/cases/[id]` (thread, triage panel, assign, escalate, status, linked tasks, "Run triage now")
  - `MessageThread({ messages })`, `TriagePanel({ triage })`
  - Server actions `sendThreadReply`, `addInternalNote`, `setTicketStatus`, `assignTicketAction`, `escalateTicketAction`, `runTriageNow`
  - `approveApproval` / `rejectApproval` emit `approval.decided` after recording the decision

- [ ] **Step 1: Shared thread and triage components**

`apps/web/src/components/message-thread.tsx` — a server component taking
`messages: Array<{ id, direction, authorKind, authorId, body, subject, status, createdAt, attachments }>`. Each message is a bordered card: inbound left-aligned white, outbound tinted `bg-blue-50`, internal tinted `bg-amber-50` with an "Internal note" label. The header line shows author, `formatDateTime(createdAt)` and, when `status` is set, `<StatusBadge value={status} />`. Attachments render as links to `attachment.url` with the name and `Math.round(size / 1024)` kB. Bodies render inside `<p className="whitespace-pre-wrap text-sm text-neutral-800">` — plain text, never `dangerouslySetInnerHTML`, because the body came from an email.

`apps/web/src/components/triage-panel.tsx` — takes `triage: TicketTriage | null`. With no triage it renders an `EmptyState` reading "Not triaged yet." Otherwise a definition list of category, severity (as a `StatusBadge`), summary, suggested fix, and confidence as a percentage.

- [ ] **Step 2: Inbox**

`apps/web/src/app/(admin)/inbox/page.tsx` — server component, `export const dynamic = "force-dynamic"`. It selects conversations for the session's organisation joined to `clients`, with the newest message per conversation via a lateral subquery, ordered by `desc(schema.conversations.lastMessageAt)`:
```ts
  const rows = await getDb()
    .select({
      id: schema.conversations.id,
      subject: schema.conversations.subject,
      status: schema.conversations.status,
      channel: schema.conversations.channel,
      participantEmail: schema.conversations.participantEmail,
      lastMessageAt: schema.conversations.lastMessageAt,
      ticketId: schema.conversations.ticketId,
      clientName: schema.clients.name,
      lastDirection: sql<string | null>`(
        select m.direction from messages m
        where m.conversation_id = ${schema.conversations.id}
        order by m.created_at desc limit 1
      )`,
    })
    .from(schema.conversations)
    .innerJoin(schema.clients, eq(schema.conversations.clientId, schema.clients.id))
    .where(eq(schema.conversations.organisationId, session.organisationId))
    .orderBy(desc(schema.conversations.lastMessageAt));
```
A row whose `lastDirection === "inbound"` is "unread": it renders with `font-semibold` and a `<StatusBadge value="needs reply" tone="warn" />`. Columns: Subject (a `Link` to `/inbox/${id}`), Client, From, Channel, Last message. Empty state: "No conversations yet. Mail sent to a client's support address appears here."

`apps/web/src/app/(admin)/inbox/[id]/page.tsx` — loads the conversation scoped by `organisationId` (`notFound()` when missing), its messages ordered by `asc(createdAt)`, and the linked ticket. It renders `PageHeader` with the subject and a link to `/cases/${ticketId}` when one exists, then `<MessageThread />`, then two forms:
- Reply: `<form action={sendThreadReply}>` with a hidden `conversationId`, a `<textarea name="body" required maxLength={8000}>` and a "Send reply" button.
- Internal note: `<form action={addInternalNote}>` with the same shape and an "Add internal note" button.

`apps/web/src/app/(admin)/inbox/[id]/actions.ts`:
```ts
"use server";

import { replyToConversation } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const ReplyInput = z.object({ conversationId: z.string().uuid(), body: z.string().trim().min(1).max(8000) });

/**
 * A staff member sending from the Inbox is a human action, so it does not go
 * through the approval gate (spec §4, Outbound email). It is still audited by
 * replyToConversation and still leaves through the same outbound.message job.
 */
async function reply(formData: FormData, internal: boolean) {
  const session = await requireAdmin();
  const { conversationId, body } = ReplyInput.parse({
    conversationId: formData.get("conversationId"),
    body: formData.get("body"),
  });
  await replyToConversation(getDb(), session.organisationId, {
    conversationId, body, actorKind: "user", actorId: session.userId, internal,
  });
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
}

export async function sendThreadReply(formData: FormData) { await reply(formData, false); }
export async function addInternalNote(formData: FormData) { await reply(formData, true); }
```

- [ ] **Step 3: Open Cases**

Replace the body of `apps/web/src/app/(admin)/tickets/page.tsx` with:
```ts
import { redirect } from "next/navigation";

// Plan 1 shipped this list at /tickets; spec §5 names the screen "Open Cases".
export default function TicketsPage() {
  redirect("/cases");
}
```

`apps/web/src/app/(admin)/cases/page.tsx` — the Plan 1 tickets table moved across, plus filters read from `searchParams` (Next 16: `const { status, severity, assignee, clientId } = await searchParams;`), validated with:
```ts
const Filters = z.object({
  status: z.enum(["open", "triaged", "in_progress", "waiting_client", "resolved", "closed"]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  assignee: z.string().optional(),
  clientId: z.string().uuid().optional(),
}).partial();
```
Unrecognised values are dropped rather than thrown, so a hand-edited URL cannot 500 the page. Each supplied filter appends an `eq(...)` to the `and(...)` conditions alongside `eq(schema.tickets.organisationId, session.organisationId)`. The filter bar is a plain `<form method="get">` of `<select>`s plus an "Apply" button — no client component needed. Default view: `status` not in `("resolved","closed")`, i.e. the *open* cases. Columns: Subject (link to `/cases/${id}`), Client, Severity, Status, Assignee, SLA due (`formatDateTime`, rendered in red when `slaDueAt < new Date()` and the ticket is unresolved), Created.

`apps/web/src/app/(admin)/cases/[id]/page.tsx` — loads the ticket scoped by organisation, its conversation messages, its `ticket_events`, the Plan 3 tasks where `eq(schema.tasks.ticketId, ticket.id)`, and `listMembers(getDb(), session.organisationId)` for the assignee select. Layout: `PageHeader` with the subject and badges; a two-column grid (`lg:grid-cols-3`) with `<MessageThread />` in the wide column and, in the sidebar, `<TriagePanel />`, the assign form, the escalate form, the status buttons, the linked-tasks list and the "Run triage now" button. Every form posts a hidden `ticketId`.

`apps/web/src/app/(admin)/cases/[id]/actions.ts`:
```ts
"use server";

import { assignTicket, escalateTicket, updateTicket } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { enqueue } from "@/lib/queue";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const TicketId = z.string().uuid();

export async function setTicketStatus(formData: FormData) {
  const session = await requireAdmin();
  const ticketId = TicketId.parse(formData.get("ticketId"));
  const status = z.enum(["open", "triaged", "in_progress", "waiting_client", "resolved", "closed"]).parse(formData.get("status"));
  await updateTicket(getDb(), session.organisationId, { ticketId, status, actorKind: "user", actorId: session.userId });
  revalidatePath(`/cases/${ticketId}`);
  revalidatePath("/cases");
}

export async function assignTicketAction(formData: FormData) {
  const session = await requireAdmin();
  const ticketId = TicketId.parse(formData.get("ticketId"));
  const raw = formData.get("assignedUserId");
  // An empty select means "let core pick the least-loaded staff member".
  const assignedUserId = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  await assignTicket(getDb(), session.organisationId, { ticketId, assignedUserId, actorKind: "user", actorId: session.userId });
  revalidatePath(`/cases/${ticketId}`);
}

export async function escalateTicketAction(formData: FormData) {
  const session = await requireAdmin();
  const ticketId = TicketId.parse(formData.get("ticketId"));
  const reason = z.string().trim().min(1).max(1000).parse(formData.get("reason"));
  await escalateTicket(getDb(), session.organisationId, { ticketId, reason, actorKind: "user", actorId: session.userId });
  revalidatePath(`/cases/${ticketId}`);
}

/** Re-runs Support Triage on demand; the worker still honours agent_enablement. */
export async function runTriageNow(formData: FormData) {
  const session = await requireAdmin();
  const ticketId = TicketId.parse(formData.get("ticketId"));
  await enqueue({ name: "ticket.created", organisationId: session.organisationId, ticketId });
  revalidatePath(`/cases/${ticketId}`);
}
```

- [ ] **Step 4: Approvals that resume**

In `apps/web/src/app/(admin)/approvals/actions.ts`, after the audit record inside `decide`, add:
```ts
  // The decision is recorded first and the resume is queued second: if the
  // queue is down the approval is still decided, and re-approving is a no-op
  // because the `where` clause requires status = "pending".
  if (after?.runId) {
    await enqueue({
      name: "approval.decided",
      organisationId: session.organisationId,
      approvalId,
      runId: after.runId,
      decision: status,
      note: note && note.length > 0 ? note : undefined,
    });
  }
```
with `import { enqueue } from "@/lib/queue";`.

In `apps/web/src/app/(admin)/approvals/page.tsx`:
- Delete the amber "Approving records the decision only. Resume arrives in Plan 2." banner and replace it with: "Approving runs the tool and resumes the agent. Rejecting tells the agent why and lets it continue."
- Above the raw payload, render the parsed tool name and input:
```tsx
  const payload = ApprovalPayload.safeParse(approval.payload);
  …
  {payload.success ? (
    <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
      <p className="text-xs uppercase tracking-wide text-neutral-400">Tool</p>
      <code className="font-mono text-sm text-neutral-900">{payload.data.toolName}</code>
      <p className="text-xs uppercase tracking-wide text-neutral-400">Input</p>
      <dl className="space-y-1 text-sm text-neutral-800">
        {Object.entries(payload.data.input as Record<string, unknown>).map(([key, value]) => (
          <div key={key} className="grid gap-1 sm:grid-cols-[8rem_1fr]">
            <dt className="text-neutral-500">{key}</dt>
            <dd className="whitespace-pre-wrap break-words">{typeof value === "string" ? value : formatJson(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  ) : null}
```
with `const ApprovalPayload = z.object({ toolName: z.string(), input: z.record(z.string(), z.unknown()) });` declared at module scope. Keep the raw `<pre>` beneath, inside a `<details>` labelled "Raw payload".

- [ ] **Step 5: Enable the nav items**

In `apps/web/src/app/(admin)/layout.tsx` (or the Plan 2 sidebar component that replaced it), give the placeholder entries their hrefs: `{ label: "Inbox", href: "/inbox" }`, `{ label: "Open Cases", href: "/cases" }`. "Knowledge Base" is enabled in Task 12.

- [ ] **Step 6: Verify by hand**

Run: `pnpm dev` and `pnpm dev:worker`, then repeat the `curl` from Task 10 Step 6. Expected: `/inbox` lists the conversation as needing a reply; `/cases` lists the ticket; `/cases/<id>` shows the triage panel populated by the agent (or "Not triaged yet." when `LLM=fake`); `/approvals` shows the parked reply with `messages_reply_to_client` and the drafted body; approving flips the message to `sent` in the thread within a second or two.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): unified inbox, open cases and approvals that resume the agent"
```

---

### Task 12: Web admin — Knowledge Base, and the client Support and Portal users tabs

**Files:**
- Create: `apps/web/src/app/(admin)/knowledge/page.tsx`, `knowledge/new/page.tsx`, `knowledge/[id]/page.tsx`, `knowledge/actions.ts`
- Create: `apps/web/src/components/markdown-editor.tsx`
- Create or replace: `apps/web/src/app/(admin)/clients/[id]/support/page.tsx`, `apps/web/src/app/(admin)/clients/[id]/portal-users/page.tsx`, `apps/web/src/app/(admin)/clients/[id]/portal-users/actions.ts`, `apps/web/src/app/(admin)/clients/[id]/portal-users/invite-form.tsx`
- Modify: the sidebar (enable "Knowledge Base")

**Interfaces:**
- Produces:
  - `/knowledge`, `/knowledge/new`, `/knowledge/[id]` with `createArticleAction`, `updateArticleAction`, `deleteArticleAction`
  - `MarkdownEditor({ name, defaultValue })` — a client component: textarea plus a live `react-markdown` preview
  - Client tab `Support` (open cases, support address, recent conversations) and `Portal users` (list + invite)
  - `invitePortalUserAction(prev, formData) → { ok: true; email; oneTimePassword } | { ok: false; error }` for `useActionState`

- [ ] **Step 1: Markdown editor**

`apps/web/src/components/markdown-editor.tsx`:
```tsx
"use client";

import { useState } from "react";
import Markdown from "react-markdown";
import { Button } from "@/components/ui/button";

/**
 * Textarea plus preview. The textarea keeps its own `name`, so the enclosing
 * server-action form posts it like any other field and the page needs no
 * client-side submit handler.
 */
export function MarkdownEditor({ name, defaultValue = "", rows = 18 }: { name: string; defaultValue?: string; rows?: number }) {
  const [value, setValue] = useState(defaultValue);
  const [preview, setPreview] = useState(false);

  return (
    <div className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
        <Button type="button" size="sm" variant={preview ? "outline" : "default"} onClick={() => setPreview(false)}>Write</Button>
        <Button type="button" size="sm" variant={preview ? "default" : "outline"} onClick={() => setPreview(true)}>Preview</Button>
        <span className="ml-auto text-xs text-neutral-400">Markdown</span>
      </div>
      {preview ? (
        <div className="prose prose-sm max-w-none p-4 text-neutral-800">
          <Markdown>{value || "_Nothing to preview yet._"}</Markdown>
        </div>
      ) : (
        <textarea
          name={name}
          rows={rows}
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full resize-y rounded-b-lg px-3 py-2 font-mono text-sm text-neutral-900 focus:outline-none"
        />
      )}
    </div>
  );
}
```
`react-markdown` renders text, not HTML, and no `rehype-raw` plugin is added — article bodies stay inert.

- [ ] **Step 2: Knowledge Base screens**

`apps/web/src/app/(admin)/knowledge/actions.ts`:
```ts
"use server";

import { createKnowledgeArticle, deleteKnowledgeArticle, updateKnowledgeArticle } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const ArticleFields = z.object({
  title: z.string().trim().min(1).max(200),
  bodyMd: z.string().trim().min(1),
  tags: z.string().trim().default(""),
  published: z.union([z.literal("on"), z.null()]).transform((v) => v === "on"),
});

function parse(formData: FormData) {
  const v = ArticleFields.parse({
    title: formData.get("title"),
    bodyMd: formData.get("bodyMd"),
    tags: formData.get("tags") ?? "",
    published: formData.get("published"),
  });
  return { ...v, tags: v.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0) };
}

export async function createArticleAction(formData: FormData) {
  const session = await requireAdmin();
  const article = await createKnowledgeArticle(getDb(), session.organisationId, parse(formData));
  revalidatePath("/knowledge");
  redirect(`/knowledge/${article.id}`);
}

export async function updateArticleAction(formData: FormData) {
  const session = await requireAdmin();
  const articleId = z.string().uuid().parse(formData.get("articleId"));
  await updateKnowledgeArticle(getDb(), session.organisationId, { articleId, ...parse(formData) });
  revalidatePath("/knowledge");
  revalidatePath(`/knowledge/${articleId}`);
}

export async function deleteArticleAction(formData: FormData) {
  const session = await requireAdmin();
  const articleId = z.string().uuid().parse(formData.get("articleId"));
  await deleteKnowledgeArticle(getDb(), session.organisationId, { articleId });
  revalidatePath("/knowledge");
  redirect("/knowledge");
}
```

`/knowledge/page.tsx` — `listKnowledgeArticles(getDb(), session.organisationId, { includeUnpublished: true })` in a table: Title (link to `/knowledge/${id}`), Slug, Tags, Published (`StatusBadge` `published` / `draft`), Updated. `PageHeader` action is a `Link` to `/knowledge/new` styled as a Button. Empty state: "No articles yet. Support Triage searches this, so the first five you write pay for themselves."

`/knowledge/new/page.tsx` — a `<form action={createArticleAction}>` with title, tags (comma separated), a `published` checkbox and `<MarkdownEditor name="bodyMd" />`.

`/knowledge/[id]/page.tsx` — the same form pre-filled, with a hidden `articleId`, posting to `updateArticleAction`, plus a separate `<form action={deleteArticleAction}>` with a destructive "Delete" button. `notFound()` when the article is missing, soft-deleted, or belongs to another organisation.

Enable `{ label: "Knowledge Base", href: "/knowledge" }` in the sidebar.

- [ ] **Step 3: Client → Support tab**

`apps/web/src/app/(admin)/clients/[id]/support/page.tsx` — a server component (Plan 2 created this as a placeholder inside its client tab layout; replace the body, keep whatever layout wrapper Plan 2 put around it). It reads `const { id } = await params`, calls `assertOwned(getDb(), session.organisationId, schema.clients, id)` and renders three blocks:

1. **Support address** — the client's `emailIdentities` row (address, display name) or an `EmptyState` reading "No support address yet. It is created automatically for new clients; run `pnpm db:seed` to backfill this one."
2. **Open cases** — tickets for this client with `status` not in `("resolved","closed")`, ordered by `desc(createdAt)`: subject (link to `/cases/${id}`), severity, status, SLA due.
3. **Recent conversations** — the five most recent conversations by `lastMessageAt`, each linking to `/inbox/${id}`.

- [ ] **Step 4: Client → Portal users tab**

`apps/web/src/app/(admin)/clients/[id]/portal-users/actions.ts`:
```ts
"use server";

import { createClientUser } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const InviteInput = z.object({
  clientId: z.string().uuid(),
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
});

export type InviteState =
  | { ok: true; email: string; oneTimePassword: string }
  | { ok: false; error: string }
  | null;

/**
 * The one-time password is returned to the browser once and never stored in
 * plaintext, so it is deliberately not written to a revalidated cache or a
 * redirect target — the caller shows it and it is gone on refresh.
 */
export async function invitePortalUserAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const session = await requireAdmin();
  const parsed = InviteInput.safeParse({
    clientId: formData.get("clientId"),
    email: formData.get("email"),
    name: formData.get("name"),
  });
  if (!parsed.success) return { ok: false, error: "Enter a name and a valid email address." };

  try {
    const result = await createClientUser(getDb(), session.organisationId, parsed.data);
    revalidatePath(`/clients/${parsed.data.clientId}/portal-users`);
    return { ok: true, email: result.user.email, oneTimePassword: result.oneTimePassword };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the portal user." };
  }
}
```

`apps/web/src/app/(admin)/clients/[id]/portal-users/invite-form.tsx`:
```tsx
"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { invitePortalUserAction, type InviteState } from "./actions";

export function InvitePortalUserForm({ clientId }: { clientId: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(invitePortalUserAction, null);

  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="clientId" value={clientId} />
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Name
          <input name="name" required className="h-9 w-48 rounded-md border border-neutral-300 px-3 text-sm text-neutral-900" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Email
          <input name="email" type="email" required className="h-9 w-72 rounded-md border border-neutral-300 px-3 text-sm text-neutral-900" />
        </label>
        <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Invite user"}</Button>
      </form>

      {state?.ok === false ? <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p> : null}
      {state?.ok ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
          <p className="font-medium">Portal account created for {state.email}.</p>
          <p className="mt-1">
            One-time password: <code className="rounded bg-white px-1.5 py-0.5 font-mono">{state.oneTimePassword}</code>
          </p>
          <p className="mt-1 text-xs">Copy it now — it is shown once and never stored. Ask them to change it under Account in the portal.</p>
        </div>
      ) : null}
    </div>
  );
}
```

`apps/web/src/app/(admin)/clients/[id]/portal-users/page.tsx` — asserts ownership, lists `clientUsers` joined to `user` (name, email, role, created), and renders `<InvitePortalUserForm clientId={id} />` beneath. Empty state: "No portal users yet. Invite one so this client can see their own sites, tasks and tickets."

- [ ] **Step 5: Verify by hand**

Run: `pnpm dev`. Create an article at `/knowledge/new`, confirm Preview renders it and that it appears in the list as `published`. Open a client's Support tab and confirm the support address and open cases show. Invite a portal user and confirm the one-time password is shown once and is gone after a refresh.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): knowledge base CRUD plus client support and portal-user tabs"
```

---

### Task 13: Web — the client portal route group and sign-in routing

**Files:**
- Create: `apps/web/src/lib/portal-session.ts`, `apps/web/src/app/after-sign-in/page.tsx`
- Create: `apps/web/src/app/(portal)/layout.tsx`, `(portal)/portal/page.tsx`, `sites/page.tsx`, `domains/page.tsx`, `tasks/page.tsx`, `support/page.tsx`, `support/new/page.tsx`, `support/[id]/page.tsx`, `support/actions.ts`, `account/page.tsx`, `account/change-password-form.tsx`
- Modify: `apps/web/src/app/sign-in/page.tsx`

**Interfaces:**
- Produces:
  - `ClientSession = { userId, email, name, organisationId, clientId, clientName, role: "client_admin" | "client_member" }`
  - `getClientSession(): Promise<ClientSession | null>`, `requireClient(): Promise<ClientSession>`
  - `/portal`, `/portal/sites`, `/portal/domains`, `/portal/tasks`, `/portal/support`, `/portal/support/new`, `/portal/support/[id]`, `/portal/account`
  - Server actions `createPortalTicket`, `replyToPortalThread`

- [ ] **Step 1: Portal session**

`apps/web/src/lib/portal-session.ts`:
```ts
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";
import { getDb } from "./db";

export type ClientSession = {
  userId: string;
  email: string;
  name: string;
  organisationId: string;
  clientId: string;
  clientName: string;
  role: "client_admin" | "client_member";
};

/**
 * The signed-in portal session. A client user belongs to exactly one client in
 * v1; when a user somehow has more than one row the oldest wins so the result
 * is deterministic. Staff sessions never resolve here, and portal users never
 * resolve through `getSession` — the two route groups cannot see each other.
 */
export async function getClientSession(): Promise<ClientSession | null> {
  const s = await getAuth().api.getSession({ headers: await headers() });
  if (!s) return null;
  const [row] = await getDb()
    .select({
      organisationId: schema.clientUsers.organisationId,
      clientId: schema.clientUsers.clientId,
      role: schema.clientUsers.role,
      clientName: schema.clients.name,
    })
    .from(schema.clientUsers)
    .innerJoin(schema.clients, eq(schema.clientUsers.clientId, schema.clients.id))
    .innerJoin(schema.organisations, eq(schema.clientUsers.organisationId, schema.organisations.id))
    .where(and(eq(schema.clientUsers.userId, s.user.id), eq(schema.organisations.status, "active")))
    .orderBy(schema.clientUsers.createdAt)
    .limit(1);
  if (!row) return null;
  return { userId: s.user.id, email: s.user.email, name: s.user.name, ...row };
}

export async function requireClient(): Promise<ClientSession> {
  const s = await getClientSession();
  if (!s) redirect("/sign-in");
  return s;
}
```

- [ ] **Step 2: Sign-in routing**

`apps/web/src/app/after-sign-in/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getClientSession } from "@/lib/portal-session";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * One landing route for both audiences: the sign-in form always pushes here,
 * and this decides. Staff membership wins if a user somehow has both, because
 * the admin portal is the more capable surface.
 */
export default async function AfterSignInPage() {
  if (await getSession()) redirect("/");
  if (await getClientSession()) redirect("/portal");
  redirect("/sign-in");
}
```
In `apps/web/src/app/sign-in/page.tsx` change `router.push("/")` to `router.push("/after-sign-in")` and update the subtitle to "Sign in to LaunchOS." Leave everything else, including `suppressHydrationWarning`, alone.

- [ ] **Step 3: Portal layout**

`apps/web/src/app/(portal)/layout.tsx` — mirrors the admin shell but with the portal nav and the client's name in the header:
```tsx
import Link from "next/link";
import { requireClient } from "@/lib/portal-session";

const NAV = [
  { label: "Overview", href: "/portal" },
  { label: "Websites", href: "/portal/sites" },
  { label: "Domains", href: "/portal/domains" },
  { label: "Progress", href: "/portal/tasks" },
  { label: "Support", href: "/portal/support" },
  { label: "Account", href: "/portal/account" },
] as const;

export const dynamic = "force-dynamic";

export default async function PortalLayout({ children }: LayoutProps<"/portal">) {
  const session = await requireClient();
  return (
    <div className="flex min-h-screen flex-1 flex-col bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-4 px-6 py-4">
          <div>
            <p className="text-sm font-semibold tracking-tight text-neutral-900">{session.clientName}</p>
            <p className="text-xs text-neutral-500">Client portal</p>
          </div>
          <nav className="flex flex-wrap gap-1 md:ml-6">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="rounded-md px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900">
                {item.label}
              </Link>
            ))}
          </nav>
          <p className="ml-auto truncate text-xs text-neutral-500">{session.email}</p>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
      <footer className="border-t border-neutral-200 bg-white px-6 py-4 text-center text-xs text-neutral-500">Powered by LaunchFlow</footer>
    </div>
  );
}
```

- [ ] **Step 4: Portal pages**

Every page starts `const session = await requireClient();` and every query carries **both** `eq(table.organisationId, session.organisationId)` and `eq(table.clientId, session.clientId)`. No page takes a client id from the URL.

- `/portal/page.tsx` — four cards: live site count (`sites` where `status = "live"`), open tickets (`tickets` where `status` not in `("resolved","closed")`), tasks in progress (Plan 3 `tasks` where `clientVisible = true` and `status` not in `("done","cancelled")`), and the most recent conversation with a link to `/portal/support/${ticketId}`. Empty state per card.
- `/portal/sites/page.tsx` — `sites` table: Name, URL (an `<a target="_blank" rel="noreferrer">`), Platform, Status.
- `/portal/domains/page.tsx` — `domains` where `eq(schema.domains.clientId, session.clientId)` (the P2 column): Name, Registrar, Expires (`formatDateTime`), Auto-renew, Status.
- `/portal/tasks/page.tsx` — Plan 3 `tasks` where `clientVisible = true`, grouped by `phase` with a progress bar per phase computed as `done / total`:
```tsx
  <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round((done / Math.max(total, 1)) * 100)}%` }} />
  </div>
```
  Task rows show title, status badge and due date. No description, no assignee — the client sees progress, not internals.
- `/portal/support/page.tsx` — the client's tickets: Subject (link to `/portal/support/${id}`), Status, Severity, Raised, Last update. `PageHeader` action links to `/portal/support/new`.
- `/portal/support/new/page.tsx` — `<form action={createPortalTicket}>` with subject, a `<select name="severity">` limited to `low | medium | high` (a client cannot self-declare `critical`) and a body textarea.
- `/portal/support/[id]/page.tsx` — loads the ticket scoped by organisation **and** `clientId` (`notFound()` otherwise), renders `<MessageThread />` filtered to `direction !== "internal"` so internal notes never leak, plus a reply form.
- `/portal/account/page.tsx` — the client's `client_contacts` (read-only) plus `<ChangePasswordForm />`.

`apps/web/src/app/(portal)/portal/support/actions.ts`:
```ts
"use server";

import { createTicket, replyToConversation } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";

const NewTicket = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  severity: z.enum(["low", "medium", "high"]),
});

export async function createPortalTicket(formData: FormData) {
  const session = await requireClient();
  const v = NewTicket.parse({
    subject: formData.get("subject"),
    body: formData.get("body"),
    severity: formData.get("severity"),
  });
  // clientId comes from the session, never the form: a portal user cannot
  // raise a ticket against somebody else's client.
  const { ticket } = await createTicket(getDb(), session.organisationId, {
    clientId: session.clientId, subject: v.subject, body: v.body, severity: v.severity,
    source: "portal", actorKind: "client", actorId: session.userId,
  });
  revalidatePath("/portal/support");
  redirect(`/portal/support/${ticket.id}`);
}

export async function replyToPortalThread(formData: FormData) {
  const session = await requireClient();
  const ticketId = z.string().uuid().parse(formData.get("ticketId"));
  const body = z.string().trim().min(1).max(8000).parse(formData.get("body"));

  const [ticket] = await getDb()
    .select({ conversationId: schema.tickets.conversationId })
    .from(schema.tickets)
    .where(and(
      eq(schema.tickets.id, ticketId),
      eq(schema.tickets.organisationId, session.organisationId),
      eq(schema.tickets.clientId, session.clientId),
    ));
  if (!ticket?.conversationId) throw new Error("ticket not found");

  // internal: true — a client reply is filed on the thread for staff to read.
  // It must not be emailed back out to the client who just wrote it.
  await replyToConversation(getDb(), session.organisationId, {
    conversationId: ticket.conversationId, body, actorKind: "client", actorId: session.userId, internal: true,
  });
  revalidatePath(`/portal/support/${ticketId}`);
}
```

`apps/web/src/app/(portal)/portal/account/change-password-form.tsx` — a client component calling `authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true })` from `@/lib/auth-client`, showing the returned error inline and a success message on `!error`. Minimum new-password length 12, checked on the client and enforced by Better Auth on the server.

- [ ] **Step 5: Verify by hand**

Run: `pnpm dev`. Sign in as the seeded owner → lands on `/`. Sign in as the seeded client user → lands on `/portal` and the admin sidebar is unreachable (`/inbox` redirects to `/sign-in`). Raise a ticket from `/portal/support/new` and confirm it appears in `/cases` in an admin session, and that an internal note added in `/inbox` is **not** visible in `/portal/support/[id]`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): client portal route group, portal session and sign-in routing"
```

---

### Task 14: Seed, Playwright acceptance, docs and env

**Files:**
- Modify: `packages/db/src/seed.ts`, `.env.example`, `README.md`, `docs/MODULE_MAP.md`, `docs/DATA_MODEL.md`, `docs/AGENT_FRAMEWORK.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`
- Create: `apps/web/tests/e2e/support-intake.spec.ts`

**Interfaces:**
- Produces: a seed that yields the `unmatched` holding client, an email identity per client, five knowledge articles, one email conversation with a ticket, one client user for Grays CabLine, and `support-triage` enabled; a Playwright spec covering spec §7's P4 acceptance.

- [ ] **Step 1: Seed**

In `packages/db/src/seed.ts`, keep the idempotent look-up-then-insert style and the production password guard. Add:

```ts
const AGENT_KEYS = ["hosting-guard-dog", "support-triage"] as const;
const HOLDING_CLIENT = { name: "Unmatched inbound", slug: "unmatched" } as const;
const CLIENT_USER = { email: "portal@grayscabline.co.uk", name: "Jo at Grays CabLine" } as const;

const KNOWLEDGE_ARTICLES = [
  { title: "DNS propagation after a nameserver change", slug: "dns-propagation", tags: ["dns"], bodyMd: "..." },
  { title: "Resetting a WordPress login", slug: "wordpress-login-reset", tags: ["content", "wordpress"], bodyMd: "..." },
  { title: "SSL certificate renewal", slug: "ssl-renewal", tags: ["hosting", "ssl"], bodyMd: "..." },
  { title: "Email deliverability: SPF, DKIM and DMARC", slug: "email-deliverability", tags: ["email"], bodyMd: "..." },
  { title: "Site down: first-response checklist", slug: "site-down-checklist", tags: ["hosting"], bodyMd: "..." },
] as const;
```
Each `bodyMd` is three or four short Markdown paragraphs of real, correct guidance — these are what Support Triage searches, so write them as if a client will read the quoted answer. All five are `published: true`.

New seed functions, each looking the row up first:
- `seedAgentEnablement` — loop over `AGENT_KEYS` instead of the single constant.
- `seedHoldingClient(db, organisationId)` — insert `HOLDING_CLIENT` when absent (by slug).
- `seedEmailIdentity(db, organisationId, clientId)` — call `ensureEmailIdentity`; skip with a printed warning when `SUPPORT_EMAIL_DOMAIN` is unset rather than failing the whole seed.
- `seedKnowledgeArticles(db, organisationId)` — `onConflictDoNothing` against `knowledge_articles_org_slug`.
- `seedSupportConversation(db, organisationId, clientId, identityAddress)` — creates one inbound email conversation and its ticket by calling `ingestInboundEmail` with a **fixed** `messageId` (`<seed-1@grayscabline.co.uk>`), which makes it idempotent for free through the duplicate check.
- `seedClientUser(db, organisationId, clientId)` — returns early when a `client_users` row already exists for `CLIENT_USER.email`; otherwise calls `createClientUser` and prints the generated password. Under `NODE_ENV=production` it refuses unless `SEED_CLIENT_PASSWORD` is set, mirroring the owner guard, and uses that value instead of a generated one.

The seed imports these from `@launchos/core`, so add `"@launchos/core": "workspace:*"` to `packages/db` **devDependencies** (seed-only, and `core` does not import `db`'s seed, so no cycle).

Run: `pnpm db:seed && pnpm db:seed` (twice)
Expected: identical output both times, no unique-constraint errors, and the printed client-user password only on the first run.

- [ ] **Step 2: Playwright acceptance**

`apps/web/tests/e2e/support-intake.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

const OWNER = {
  email: process.env.SEED_OWNER_EMAIL ?? "shujaat@nexusedu.co.uk",
  password: process.env.SEED_OWNER_PASSWORD ?? "change-me-now",
};
const CLIENT = {
  email: process.env.SEED_CLIENT_USER_EMAIL ?? "portal@grayscabline.co.uk",
  password: process.env.SEED_CLIENT_PASSWORD ?? "change-me-now",
};
const SUPPORT_ADDRESS = process.env.SEED_SUPPORT_ADDRESS ?? "grays-cabline@support.launchflow.co.uk";

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe.serial("P4 support intake", () => {
  const subject = `Site slow ${Date.now()}`;
  const messageId = `<e2e-${Date.now()}@grayscabline.co.uk>`;

  test("an inbound email becomes a case, and an approved reply is sent", async ({ page, request }) => {
    const response = await request.post("/api/webhooks/email/inbound?provider=generic", {
      headers: { "x-launchos-inbound-secret": process.env.INBOUND_EMAIL_SECRET ?? "change-me" },
      data: {
        to: [SUPPORT_ADDRESS], from: "jo@grayscabline.co.uk", subject,
        text: "Every page takes about twenty seconds to load since yesterday.", messageId,
      },
    });
    expect(response.status()).toBe(202);

    await signIn(page, OWNER.email, OWNER.password);
    await page.waitForURL("/");

    // The worker ingests asynchronously; poll the list rather than sleeping.
    await expect(async () => {
      await page.goto("/cases");
      await expect(page.getByRole("link", { name: subject })).toBeVisible();
    }).toPass({ timeout: 30_000 });

    await page.goto("/inbox");
    await expect(page.getByRole("link", { name: subject })).toBeVisible();

    // Reply as a human from the inbox: no approval, straight to sent.
    await page.getByRole("link", { name: subject }).click();
    await page.getByRole("textbox", { name: /reply/i }).fill("Thanks Jo — we are looking at it now.");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(async () => {
      await page.reload();
      await expect(page.getByText("sent", { exact: false })).toBeVisible();
    }).toPass({ timeout: 30_000 });
  });

  test("a parked agent reply is approved and the run resumes", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.waitForURL("/");
    await page.goto("/approvals");

    const parked = page.getByText("messages_reply_to_client").first();
    test.skip((await parked.count()) === 0, "no parked reply — the Support Triage run needs a real ANTHROPIC_API_KEY");

    await page.getByRole("button", { name: "Approve" }).first().click();
    await expect(async () => {
      await page.reload();
      await expect(page.getByText("Nothing waiting for a decision.")).toBeVisible();
    }).toPass({ timeout: 30_000 });
  });

  test("a client user sees only their own tickets and can reply", async ({ page }) => {
    await signIn(page, CLIENT.email, CLIENT.password);
    await page.waitForURL("/portal");
    await expect(page.getByText("Grays CabLine")).toBeVisible();

    await page.goto("/portal/support");
    await page.getByRole("link", { name: subject }).click();
    await page.getByRole("textbox", { name: /reply/i }).fill("Thank you, that is helpful.");
    await page.getByRole("button", { name: /send/i }).click();
    await expect(page.getByText("Thank you, that is helpful.")).toBeVisible();

    // The admin surfaces are not reachable from a portal session.
    await page.goto("/cases");
    await page.waitForURL(/\/sign-in/);
  });
});
```

Run: `pnpm db:up && pnpm db:migrate && pnpm db:seed`, start `pnpm dev:worker`, then `pnpm --filter @launchos/web e2e`.
Expected: three passes (the middle one skips when no Anthropic key is configured, which is the documented external blocker).

- [ ] **Step 3: Env**

Add to `.env.example`, under a new `# ---- Support intake (Plan 4) ----` heading, each with a one-line comment naming what it unlocks:
```bash
# Domain the per-client support addresses live on, e.g. grays-cabline@support.launchflow.co.uk
SUPPORT_EMAIL_DOMAIN=support.launchflow.co.uk
# Which inbound webhook payload shape to expect: generic | postmark | cloudflare
INBOUND_EMAIL_PROVIDER=generic
# Outbound mail: mock (records only, default) | smtp (needs SMTP_* above)
EMAIL_ADAPTER=mock
# Owner in-app notifications are also emailed here when set
OWNER_NOTIFY_EMAIL=
# Where inbound attachments are written
STORAGE_DIR=./storage
# Seed-only: portal user for Grays CabLine
SEED_CLIENT_USER_EMAIL=portal@grayscabline.co.uk
SEED_CLIENT_PASSWORD=
```
`INBOUND_EMAIL_SECRET`, `SMTP_*` and `MAIL_FROM` already exist — leave them where they are and extend their comments to say which feature needs them.

- [ ] **Step 4: Docs**

`docs/MODULE_MAP.md` — add the admin routes `/inbox`, `/inbox/[id]`, `/cases`, `/cases/[id]`, `/knowledge`, `/settings/email` and the client tabs; fill in the `(portal)` section with the eight portal routes; add `packages/channels` to the package list; note `/tickets` now redirects to `/cases`.

`docs/DATA_MODEL.md` — add `email.ts` (`email_identities`) and fill in the existing `knowledge.ts` section with the real `knowledge_articles` columns including the generated `search` tsvector and its GIN index; extend the `support.ts` section with the P4 columns; add the relationship line "a conversation points at its ticket and a ticket points back at its conversation; both are written in one transaction."

`docs/AGENT_FRAMEWORK.md` —
- Correct the tool names in the `support-triage` section to underscores and to the nine tools actually shipped, and state the trigger, prompt shape and output (`tickets.triage`).
- Replace the one-line "Resume" sentence under the run loop with the real contract: `agent_runs.metadata.pending = { messages, completedResults, awaitingToolUseId, remainingToolUseIds }`; `resumeAgent(def, { runId, approvalId, decision, note })` reopens the recorder (seq continues), executes the approved tool **without** re-consulting the policy gate, substitutes `rejected by human: <note>` as an `is_error` result on rejection, marks every `remainingToolUseIds` entry `skipped pending approval`, then re-enters the shared `runLoop`.
- Note that `runAgent` and `resumeAgent` share `run-loop.ts`, so the two paths cannot drift.

`docs/ARCHITECTURE.md` —
- Under **Queues**, add `inbound.message`, `outbound.message` and `agent.resume` with their singleton keys.
- Under **Events**, add the three new `DomainEvent` variants and the table of event → queue mappings, noting that both `apps/worker/src/index.ts` and `apps/web/src/lib/queue.ts` implement it and must stay in step.
- Add a **Webhooks** section: `POST /api/webhooks/email/inbound` validates the shared secret in `x-launchos-inbound-secret` with a constant-time compare, normalises by provider, writes attachments to `STORAGE_DIR`, resolves the organisation from `email_identities`, and enqueues — it performs no business writes, so a slow database cannot time the provider out.

`docs/DEPLOYMENT.md` — a new **Inbound email** section:
- DNS for `SUPPORT_EMAIL_DOMAIN`: MX records pointing at the chosen provider, plus SPF (`v=spf1 include:<provider> ~all`), a DKIM CNAME/TXT from the provider, and a DMARC record `v=DMARC1; p=none; rua=mailto:…` to start.
- **Postmark:** create a server, enable the inbound stream, set the inbound webhook to `https://<app-domain>/api/webhooks/email/inbound?provider=postmark`, add a custom header `x-launchos-inbound-secret` with the `INBOUND_EMAIL_SECRET` value, point the domain's MX at Postmark's inbound host, verify the sending signature.
- **Cloudflare Email Routing:** enable Email Routing on the zone, add a catch-all rule that sends to a Worker, and give the Worker code that reads the message and POSTs the `normalizeCloudflare` shape (`{ to, from, subject, text, html, headers }`) to `?provider=cloudflare` with the same secret header. State plainly that Cloudflare Email Routing does not forward attachments in this shape, so attachments arrive only on the Postmark and generic paths.
- **Outbound:** set `EMAIL_ADAPTER=smtp`, `SMTP_HOST/PORT/USER/PASS` and `MAIL_FROM` to a verified sender on the same domain; leave `EMAIL_ADAPTER=mock` until the DNS records verify.
- **Storage:** mount a persistent volume at `STORAGE_DIR` on the Coolify web resource, otherwise attachments vanish on redeploy.
- List the P4 external blockers: an inbound provider account, DNS control of `SUPPORT_EMAIL_DOMAIN`, SMTP credentials, and `ANTHROPIC_API_KEY` for real Support Triage runs.

`README.md` — refresh the Status section: Plan 4 delivers support intake, the unified inbox, tickets with SLA and triage, the knowledge base, approval resume, the Support Triage agent and the client portal; Plan 5 (payments, invoices, ads, reporting) is next. Add `pnpm --filter @launchos/web e2e` to Quick start.

- [ ] **Step 5: Full verification**

Run, from a clean database:
```bash
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @launchos/web e2e
```
Expected: typecheck and lint clean; every Vitest suite green; the Playwright spec green (with the middle test skipped when no Anthropic key is set).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(plan-4): seed support fixtures, Playwright acceptance, docs and env"
```

---

## Self-review

- **Spec coverage.** §1 row P4: per-client support address (Tasks 1, 3), inbound webhook adapters (Tasks 2, 10), unified inbox (Task 11), tickets with threads and internal notes (Tasks 4, 11), outbound email via SMTP with approval (Tasks 2, 4, 7, 9), Support Triage (Task 8), `agent.resume` (Tasks 6, 9), notifications to Shoji (Tasks 3, 4), client portal and client users (Tasks 5, 12, 13). §3 P4 data model is Task 1 in full. §4 "Support intake", "Support Triage agent", "Approval resume", "Outbound email" and the P4 half of "Client portal" each map to a named task. §5 nav: Inbox, Open Cases and Knowledge Base are enabled in Tasks 11 and 12; the client Support and Portal users tabs are Task 12. §6 env vars are Task 14 Step 3. §7 P4 acceptance is the Playwright spec in Task 14 Step 2, which covers inbound → ticket, approve → resume → sent, and a client user seeing and replying to only their own ticket.
- **Placeholders.** None. Everything deferred is named as Plan 5 (payments, invoices, ads, reports, and the `/portal/invoices` and `/portal/reports` routes) or as an external blocker (real Cloudflare DNS and CMS clients, real SMTP, an Anthropic key).
- **Names.** Every identifier is defined in this plan, exists in the codebase today, or is on the stated P2/P3 interface list. From P2: `clients.slug`, `clients.supportEmail`, `notifications`, `activityEvents`, `domains.clientId`, `recordActivity`, `notifyOwner`, `listMembers`, `assertOwned`, `enqueue`, the sidebar placeholders, the client tab shells. From P3: `tasks`, `createTask`, `pickLeastLoadedStaff`. From Plan 1: `withTestDb`, `createTicket`, `recordAudit`, `emit`/`setEnqueue`, `defineTool`, `runAgent`, `RunRecorder`, `FakeLlmClient`, `toClaudeTools`, `findTool`, `decide`, `MockUptimeProbe`, `MockHostingProvider`, `PageHeader`, `EmptyState`, `StatusBadge`, `formatDateTime`, `formatJson`, `getDb`, `getAuth`, `requireAdmin`, `authClient`.
- **Type consistency.** `InboundEmail` is produced by `storeInboundAttachments` in the webhook, carried by `DomainEvent.email.received`, consumed by `handleInboundMessage` and validated again by `ingestInboundEmail` — one shape end to end. `replyToConversation` returns a `messages` row whose `status` is `"queued"`, which is exactly what `sendQueuedMessage` requires and what `handleOutboundMessage` passes on. `resumeAgent`'s `PendingState` matches the `buildPendingMetadata` shape that `run-agent.ts` already writes (`messages`, `completedResults`, `awaitingToolUseId`, `remainingToolUseIds`), verified against `run-agent.test.ts`'s existing batch-parking assertion. `AgentResumeJob` fields match `approval.decided`'s fields one for one.
- **Deviations, stated on purpose.** (a) `tickets.assigned_user_id` is reused instead of adding the spec's `assignee_user_id` — a second column would be a duplicate of a Plan 1 column. (b) `messages.status` is nullable so internal notes are not forced into an email status. (c) A client's own reply from the portal is written `internal: true`, because emailing a client back the words they just typed would be absurd; staff still see it on the thread. (d) The Plan 1 `/tickets` route becomes a redirect to `/cases` to match spec §5's naming.
- **Security.** The webhook compares `INBOUND_EMAIL_SECRET` in constant time and rejects a length mismatch before comparing; a malformed payload returns 422 rather than being retried forever. Attachment filenames are reduced to `basename` and stored under a generated name; the download route requires an admin session and refuses any organisation but the caller's. `dns_update_record` reads the zone from our own `domains` row rather than the model's input, so an approved change cannot touch a domain we do not manage; `cms_update_content` does the same with `sites.hostingRef`. Message bodies render as plain text — no `dangerouslySetInnerHTML`, and `react-markdown` runs without `rehype-raw`. `searchKnowledge` uses `plainto_tsquery`, so no tsquery operator can be injected. Portal queries take `clientId` from the session only. Secrets are never rendered on Settings → Email.
- **Idempotency.** `ingestInboundEmail` short-circuits on a duplicate `messageId`; `sendQueuedMessage` returns early unless the status is still `queued`; the queue sends use singleton keys derived from the message id, ticket id or approval id; `ensureEmailIdentity` and every seed function look up before inserting.
- **Things I fixed while reviewing.** (1) The first draft called `createTicket` from `ingestInboundEmail` and got a second, empty conversation — fixed by adding the optional `conversationId` and skipping the opening-message insert, with the existing `create-ticket.test.ts` proving the default path is unchanged. (2) `resumeAgent` first duplicated the loop from `run-agent.ts`; extracting `run-loop.ts` removes the drift risk and is why Task 6 Step 4 re-runs the Plan 1 kernel tests before the new one. (3) `RunRecorder.seq` restarted at 0 on resume and violated the `agent_steps_run_seq` unique index — `reopen` now continues the sequence, and the test asserts contiguous seq values. (4) The webhook originally did the full ingest inline; moving every write to the worker keeps the provider's timeout budget out of the database's hands. (5) `first_response_at` was a read-then-write race; the `isNull` predicate in the same `UPDATE` fixes it. (6) The portal reply initially used `internal: false` and would have emailed the client their own message back.
- **Risks to watch during execution.** drizzle-kit may emit the generated tsvector column without `STORED` (Task 1 Step 5 says what to do). `pickLeastLoadedStaff` returning `null` on a solo-operator organisation is handled with an explicit error rather than a silent unassigned ticket. `apps/web/src/lib/queue.ts` repeats the five queue-name strings that `apps/worker/src/boss.ts` owns; that duplication is deliberate (no `apps/*` → `apps/*` imports) and is called out in the code comment.
