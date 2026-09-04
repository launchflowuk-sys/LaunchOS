# Plan 5: Payments, Invoices, Ads and Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give LaunchOS the money and measurement half of the agency: subscriptions and invoices per client package (Stripe adapter, mock when unset), payments and overdue detection that raises a billing ticket, ad accounts with daily metric snapshots, the Ad Performance Sentinel agent that flags a ROAS drop and drafts a client-facing report, and monthly client reports the client can read in the portal.

**Architecture:** Two new mock-first adapters in `packages/integrations` (`payments`, `ads`) behind interfaces picked by env. New `packages/core` domains — `billing` (subscriptions, invoices, payments), `ads` (accounts, ingest, signals) and `reports` (client reports) — all on the `(db, organisationId, input)` contract with `assertOwned` guards and `audit_log` writes. The worker gains four cron jobs and a Stripe webhook consumer; the web app gains the Stripe webhook route, five admin modules and two portal modules. The `ad-performance-sentinel` agent plugs into the existing kernel with four safe tools and one `requires_approval` tool.

**Tech Stack:** Node 24, pnpm 11, TypeScript 5 strict, Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui, Drizzle ORM + drizzle-kit, `postgres` driver, Better Auth, pg-boss, Zod 4, `@anthropic-ai/sdk`, `stripe`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-agency-os-full-build.md` (§1 row P5, §2, §3 P5, §4 Payments / Ads / Client portal, §5, §6, §7 P5). The Ad Performance Sentinel definition is `docs/superpowers/specs/2026-09-03-agency-os-design.md` §5.

## Global Constraints

- Everything in `CLAUDE.md` binds: tenancy, approval gate, audit log, mock-first integrations, secrets in env only, immutable updates, small files.
- Node `>=24`, pnpm `11.12.0`, TypeScript `strict: true` with `noUncheckedIndexedAccess`.
- PostgreSQL 17 self-hosted only. No Supabase. No Redis.
- Every business table has `organisation_id uuid not null references organisations(id) on delete cascade`.
- Every core service signature starts `(db: Db, organisationId: string, …)` and every query filters on `organisationId`.
- **Ownership assertions.** Any service taking a foreign id asserts it belongs to `organisationId` via `assertOwned(db, organisationId, table, id)` from `packages/core/src/tenancy/assert-owned.ts`.
- **Transactions.** Multi-write services run inside `db.transaction`; domain events emit after commit.
- **Domain events.** Extend `DomainEvent` in `packages/core/src/events/emit.ts`. The worker maps events to jobs; the web process sets its own enqueue function via `apps/web/src/lib/queue.ts`.
- **Notifications.** The owner is notified in-app for payment failed and invoice overdue via `notifyOwner`. Email to the owner goes out when `OWNER_NOTIFY_EMAIL` is set.
- **Financial details.** Never store card numbers or bank details. `billing_profiles` (Plan 2) holds billing name, address, VAT number, payment terms, Stripe customer id and a preferred-method label. That is the whole financial surface.
- Tools declare `risk: "safe" | "requires_approval"`. Anything that sends a client message, publishes, or moves money outward is `requires_approval`.
- Default model `claude-opus-5`, `thinking: { type: "adaptive" }`, `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`.
- Zod at every boundary: tool inputs, API bodies, server-action form data, env vars.
- **UI.** shadcn, white/light, dense but calm tables, page header with primary action, empty states with a call to action, footer "Powered by LaunchFlow". Wide tables scroll inside `overflow-x-auto`.
- **Tests.** Vitest on every core service against the docker Postgres inside a rolled-back transaction (`withTestDb`); the agent test uses `FakeLlmClient`; one Playwright smoke covers the plan's main flow. Test data uses random slugs and emails.
- Files 800 lines max, 200–400 typical; functions under 50 lines.
- Commit after every task with a conventional-commit message. Branch `build/agency-os`. Do not push.

---

## Interfaces inherited from Plans 2, 3 and 4

These already exist when this plan starts. Do not redefine them; import and use them as written.

**From Plan 2 (migration 0003):**
- `schema.clients.slug` (unique per organisation), `schema.clients.packageId`.
- `schema.billingProfiles` — one row per client, columns include `clientId`, `billingName`, `addressLine1`, `addressLine2`, `city`, `postcode`, `country`, `vatNumber`, `paymentTermsDays` (int, default 14), `stripeCustomerId`, `preferredMethod`, `notes`.
- `schema.notifications`, `schema.activityEvents`.
- `notifyOwner(db, organisationId, { kind, title, body?, link? })` from `@launchos/core`.
- `recordActivity(db, organisationId, { clientId?, siteId?, actorKind, actorId?, kind, title, body?, link? })` from `@launchos/core`.
- `assertOwned(db, organisationId, table, id)` from `@launchos/core` — generic ownership guard for any table carrying `id` and `organisationId`.
- The admin sidebar in `apps/web/src/app/(admin)/layout.tsx` with **disabled** "Payments", "Invoices" and "Ads" entries this plan turns into links.
- Client detail tab routes under `apps/web/src/app/(admin)/clients/[id]/` — `overview`, `billing` (Contacts & Billing), `sites`, `tasks`, `support`, `invoices`, `reports`, `portal-users`. The `invoices` and `reports` tabs are placeholders this plan fills.
- `apps/web/src/lib/queue.ts` exporting `enqueue(event: DomainEvent): Promise<void>` — a thin pg-boss `send` client mapping domain events to queues from the web process.

**From Plan 3 (migration 0004):**
- `schema.packages` exported from `packages/db/src/schema/packages.ts` — columns include `name`, `slug`, `description`, `monthlyPricePence`, `setupPricePence`, `currency`, `includes` (jsonb), `active`.
- `schema.tasks` with `status` (`todo|in_progress|blocked|review|done|cancelled`), `phase`, `kind`, `clientId`, `completedAt`, `clientVisible`.
- `createTask(db, organisationId, {...})` from `@launchos/core`.

**From Plan 4 (migration 0005):**
- `createTicket(db, organisationId, input)` — unchanged from Plan 1 plus an optional `assigneeUserId`.
- `packages/channels` exporting `EmailAdapter { send(msg: { to: string; subject: string; text: string; html?: string }): Promise<{ id: string }> }`, `MockEmailAdapter`, `SmtpEmailAdapter` and `createEmailAdapter(env: NodeJS.ProcessEnv): EmailAdapter`.
- `resumeAgent(...)` in `packages/agents/src/kernel/resume-agent.ts`, consumed by the `agent.resume` queue. The `requires_approval` tool this plan adds parks and resumes through that machinery unchanged.
- The `(portal)` route group with `requireClient(): Promise<{ userId: string; organisationId: string; clientId: string }>` in `apps/web/src/lib/portal-session.ts`, and the portal layout nav in `apps/web/src/app/(portal)/portal/layout.tsx` where this plan adds Invoices and Reports.
- The seeded client user for Grays CabLine (`client_users` row plus a Better Auth account).

---

## File structure for this plan

```
packages/db/src/schema/billing.ts              subscriptions, invoices, invoice_sequences, payments
packages/db/src/schema/ads.ts                  ad_accounts, ad_metric_snapshots, ad_reports
packages/db/src/schema/reports.ts              client_reports
packages/db/drizzle/0006_*.sql                 generated migration

packages/integrations/src/payments/types.ts    PaymentsAdapter interface + DTOs
packages/integrations/src/payments/mock.ts     MockPaymentsAdapter
packages/integrations/src/payments/stripe.ts   StripePaymentsAdapter
packages/integrations/src/payments/index.ts    createPaymentsAdapter(env)
packages/integrations/src/ads/types.ts         AdsAdapter interface + DTOs
packages/integrations/src/ads/mock.ts          MockAdsAdapter (seeded hash, configurable drop date)
packages/integrations/src/ads/google.ts        GoogleAdsAdapter (credentials required)
packages/integrations/src/ads/meta.ts          MetaAdsAdapter (credentials required)
packages/integrations/src/ads/index.ts         createAdsAdapter(env)

packages/core/src/billing/subscriptions.ts     createSubscription, cancelSubscription
packages/core/src/billing/invoice-number.ts    nextInvoiceNumber
packages/core/src/billing/invoices.ts          createInvoiceFromSubscription, markInvoiceSent/Paid, voidInvoice
packages/core/src/billing/overdue.ts           findOverdueInvoices
packages/core/src/billing/payments.ts          recordPayment, reconcileInvoice
packages/core/src/billing/webhook-sync.ts      findOrganisationByStripeCustomer, syncFromPaymentsEvent
packages/core/src/billing/invoice-send.ts      requestInvoiceSend, sendApprovedInvoice
packages/core/src/ads/accounts.ts              createAdAccount, listAdAccounts
packages/core/src/ads/ingest.ts                ingestDailyMetrics
packages/core/src/ads/signals.ts               computeAccountSignals
packages/core/src/ads/reports.ts               saveDraftAdReport, approveAdReport, sendAdReport
packages/core/src/reports/build-client-report.ts  buildClientReport
packages/core/src/reports/publish.ts           publishClientReport

packages/agents/src/tools/ads-list-accounts.ts
packages/agents/src/tools/ads-get-signals.ts
packages/agents/src/tools/ads-save-draft-report.ts
packages/agents/src/tools/reports-send-to-client.ts
packages/agents/src/tools/tickets-create.ts    (modified: agent-key factory)
packages/agents/src/agents/ad-performance-sentinel/index.ts

apps/worker/src/jobs/payments-webhook.ts
apps/worker/src/jobs/ads-ingest.ts
apps/worker/src/jobs/invoices-overdue.ts
apps/worker/src/jobs/reports-monthly.ts
apps/worker/src/jobs/ads-sentinel.ts

apps/web/src/app/api/webhooks/stripe/route.ts
apps/web/src/app/(admin)/payments/{page.tsx,actions.ts}
apps/web/src/app/(admin)/invoices/{page.tsx,actions.ts,[id]/page.tsx}
apps/web/src/app/(admin)/ads/{page.tsx,actions.ts,[accountId]/page.tsx,reports/page.tsx}
apps/web/src/app/(admin)/reports/{page.tsx,actions.ts,[id]/page.tsx}
apps/web/src/app/(admin)/settings/billing/page.tsx
apps/web/src/app/(admin)/clients/[id]/invoices/page.tsx
apps/web/src/app/(admin)/clients/[id]/reports/page.tsx
apps/web/src/app/(admin)/clients/[id]/billing/subscription-panel.tsx
apps/web/src/app/(admin)/clients/[id]/billing/subscription-actions.ts
apps/web/src/app/(portal)/portal/invoices/{page.tsx,[id]/page.tsx}
apps/web/src/app/(portal)/portal/reports/{page.tsx,[id]/page.tsx}
apps/web/src/components/sparkline.tsx
apps/web/tests/e2e/billing-ads-reports.spec.ts
```

---

### Task 1: Migration 0006 — billing, ads and reporting schema

**Files:**
- Create: `packages/db/src/schema/billing.ts`, `packages/db/src/schema/ads.ts`, `packages/db/src/schema/reports.ts`
- Modify: `packages/db/src/schema/index.ts`
- Test: `packages/db/src/schema/billing-schema.test.ts`

**Interfaces:**
- Consumes: `tenantColumns()` from `./_shared.js`, `clients` from `./clients.js`, `packages` from `./packages.js` (Plan 3), `messages` from `./support.js`, `agentRuns` from `./agents.js`.
- Produces: `schema.subscriptions`, `schema.invoices`, `schema.invoiceSequences`, `schema.payments`, `schema.adAccounts`, `schema.adMetricSnapshots`, `schema.adReports`, `schema.clientReports`, and the enums `subscriptionStatusEnum`, `invoiceStatusEnum`, `paymentProviderEnum`, `paymentStatusEnum`, `adPlatformEnum`, `adAccountStatusEnum`, `adReportStatusEnum`, `clientReportStatusEnum`.

- [ ] **Step 1: Write the failing schema test**

`packages/db/src/schema/billing-schema.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "../test/db.js";
import {
  adAccounts, adMetricSnapshots, adReports, clientReports, clients, invoices,
  organisations, payments, subscriptions,
} from "./index.js";

describe("P5 schema", () => {
  it("stores a subscription, invoice, payment, ad snapshot and client report for one client", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "T", slug: `p5-${randomUUID()}` }).returning();
      const [client] = await db.insert(clients).values({ organisationId: org!.id, name: "Grays CabLine" }).returning();

      const [sub] = await db.insert(subscriptions).values({
        organisationId: org!.id, clientId: client!.id, amountPence: 29900,
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
      }).returning();
      expect(sub!.status).toBe("active");
      expect(sub!.currency).toBe("GBP");

      const [invoice] = await db.insert(invoices).values({
        organisationId: org!.id, clientId: client!.id, subscriptionId: sub!.id, number: "LF-2026-0001",
        issuedAt: new Date("2026-09-01T00:00:00Z"), dueAt: new Date("2026-09-15T00:00:00Z"),
        subtotalPence: 29900, vatPence: 5980, totalPence: 35880,
        lineItems: [{ description: "Growth package — September 2026", quantity: 1, unitPence: 29900 }],
      }).returning();
      expect(invoice!.status).toBe("draft");

      const [payment] = await db.insert(payments).values({
        organisationId: org!.id, clientId: client!.id, invoiceId: invoice!.id,
        amountPence: 35880, provider: "bank", status: "succeeded", paidAt: new Date(),
      }).returning();
      expect(payment!.currency).toBe("GBP");

      const [account] = await db.insert(adAccounts).values({
        organisationId: org!.id, clientId: client!.id, platform: "google",
        externalId: "123-456-7890", name: "Grays CabLine — Search",
      }).returning();
      await db.insert(adMetricSnapshots).values({
        organisationId: org!.id, adAccountId: account!.id, date: "2026-09-01",
        spendPence: 12000, impressions: 5400, clicks: 210, conversions: 14,
        conversionValuePence: 84000, cpcPence: 57.1, roas: 7,
      });
      const snaps = await db.select().from(adMetricSnapshots).where(eq(adMetricSnapshots.adAccountId, account!.id));
      expect(snaps).toHaveLength(1);

      const [report] = await db.insert(adReports).values({
        organisationId: org!.id, adAccountId: account!.id,
        periodStart: "2026-08-25", periodEnd: "2026-08-31", summaryMd: "## Ads\nROAS fell 24%.",
      }).returning();
      expect(report!.status).toBe("draft");

      const [clientReport] = await db.insert(clientReports).values({
        organisationId: org!.id, clientId: client!.id,
        periodStart: "2026-08-01", periodEnd: "2026-08-31",
        summaryMd: "## August\nAll good.", stats: { tasksDone: 4 },
      }).returning();
      expect(clientReport!.status).toBe("draft");
    });
  });

  it("rejects a second snapshot for the same account and date", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "T", slug: `p5-${randomUUID()}` }).returning();
      const [client] = await db.insert(clients).values({ organisationId: org!.id, name: "C" }).returning();
      const [account] = await db.insert(adAccounts).values({
        organisationId: org!.id, clientId: client!.id, platform: "meta", externalId: "act_1", name: "A",
      }).returning();
      const row = {
        organisationId: org!.id, adAccountId: account!.id, date: "2026-09-01",
        spendPence: 1, impressions: 1, clicks: 1, conversions: 0, conversionValuePence: 0, cpcPence: 1, roas: 0,
      };
      await db.insert(adMetricSnapshots).values(row);
      await expect(db.insert(adMetricSnapshots).values(row)).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/db test`
Expected: FAIL — `Cannot find module './billing.js'` / no export named `subscriptions` from `./index.js`.

- [ ] **Step 3: Write the billing schema**

`packages/db/src/schema/billing.ts`:
```ts
import { integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { packages } from "./packages.js";

export const subscriptionStatusEnum = pgEnum("subscription_status", ["trialing", "active", "past_due", "cancelled", "paused"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["draft", "sent", "paid", "overdue", "void"]);
export const paymentProviderEnum = pgEnum("payment_provider", ["stripe", "bank", "cash", "other"]);
export const paymentStatusEnum = pgEnum("payment_status", ["pending", "succeeded", "failed", "refunded"]);

/** One invoice line as stored in invoices.line_items. */
export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPence: number;
}

export const subscriptions = pgTable("subscriptions", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  packageId: uuid("package_id").references(() => packages.id, { onDelete: "set null" }),
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: subscriptionStatusEnum("status").default("active").notNull(),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
  amountPence: integer("amount_pence").notNull(),
  currency: text("currency").default("GBP").notNull(),
}, (t) => [uniqueIndex("subscriptions_org_stripe_id").on(t.organisationId, t.stripeSubscriptionId)]);

export const invoices = pgTable("invoices", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
  number: text("number").notNull(),
  status: invoiceStatusEnum("status").default("draft").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  subtotalPence: integer("subtotal_pence").notNull(),
  vatPence: integer("vat_pence").default(0).notNull(),
  totalPence: integer("total_pence").notNull(),
  currency: text("currency").default("GBP").notNull(),
  stripeInvoiceId: text("stripe_invoice_id"),
  pdfUrl: text("pdf_url"),
  lineItems: jsonb("line_items").$type<InvoiceLineItem[]>().default([]).notNull(),
}, (t) => [
  uniqueIndex("invoices_org_number").on(t.organisationId, t.number),
  uniqueIndex("invoices_org_stripe_id").on(t.organisationId, t.stripeInvoiceId),
]);

/**
 * Per-organisation, per-year invoice counter. Numbers are allocated with a
 * single upserting statement so two concurrent invoices can never collide.
 */
export const invoiceSequences = pgTable("invoice_sequences", {
  ...tenantColumns(),
  year: integer("year").notNull(),
  nextNumber: integer("next_number").default(0).notNull(),
}, (t) => [uniqueIndex("invoice_sequences_org_year").on(t.organisationId, t.year)]);

export const payments = pgTable("payments", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  amountPence: integer("amount_pence").notNull(),
  currency: text("currency").default("GBP").notNull(),
  provider: paymentProviderEnum("provider").default("other").notNull(),
  providerRef: text("provider_ref"),
  status: paymentStatusEnum("status").default("pending").notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (t) => [uniqueIndex("payments_org_provider_ref").on(t.organisationId, t.provider, t.providerRef)]);
```

- [ ] **Step 4: Write the ads and reports schemas**

`packages/db/src/schema/ads.ts`:
```ts
import { date, doublePrecision, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { agentRuns } from "./agents.js";
import { clients } from "./clients.js";
import { messages } from "./support.js";

export const adPlatformEnum = pgEnum("ad_platform", ["google", "meta"]);
export const adAccountStatusEnum = pgEnum("ad_account_status", ["active", "paused", "disconnected"]);
export const adReportStatusEnum = pgEnum("ad_report_status", ["draft", "approved", "sent"]);

export const adAccounts = pgTable("ad_accounts", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  platform: adPlatformEnum("platform").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  currency: text("currency").default("GBP").notNull(),
  status: adAccountStatusEnum("status").default("active").notNull(),
}, (t) => [uniqueIndex("ad_accounts_org_platform_external").on(t.organisationId, t.platform, t.externalId)]);

// Money is stored in whole pence; cpc_pence is fractional because a cost per
// click is routinely a fraction of a penny once averaged over a day.
export const adMetricSnapshots = pgTable("ad_metric_snapshots", {
  ...tenantColumns(),
  adAccountId: uuid("ad_account_id").notNull().references(() => adAccounts.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  spendPence: integer("spend_pence").default(0).notNull(),
  impressions: integer("impressions").default(0).notNull(),
  clicks: integer("clicks").default(0).notNull(),
  conversions: integer("conversions").default(0).notNull(),
  conversionValuePence: integer("conversion_value_pence").default(0).notNull(),
  cpcPence: doublePrecision("cpc_pence").default(0).notNull(),
  roas: doublePrecision("roas").default(0).notNull(),
}, (t) => [uniqueIndex("ad_metric_snapshots_account_date").on(t.adAccountId, t.date)]);

export const adReports = pgTable("ad_reports", {
  ...tenantColumns(),
  adAccountId: uuid("ad_account_id").notNull().references(() => adAccounts.id, { onDelete: "cascade" }),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  summaryMd: text("summary_md").notNull(),
  status: adReportStatusEnum("status").default("draft").notNull(),
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  sentMessageId: uuid("sent_message_id").references(() => messages.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});
```

`packages/db/src/schema/reports.ts`:
```ts
import { date, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

export const clientReportStatusEnum = pgEnum("client_report_status", ["draft", "published"]);

/** The numbers behind a monthly client report, rendered above the Markdown. */
export interface ClientReportStats {
  tasksDone: number;
  tasksOpen: number;
  uptimePercent: number | null;
  ticketsOpened: number;
  ticketsResolved: number;
  ads: { spendPence: number; clicks: number; conversions: number; roas: number } | null;
  invoices: { issued: number; paidPence: number; outstandingPence: number };
}

export const clientReports = pgTable("client_reports", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  summaryMd: text("summary_md").notNull(),
  stats: jsonb("stats").$type<Partial<ClientReportStats>>().default({}).notNull(),
  status: clientReportStatusEnum("status").default("draft").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (t) => [uniqueIndex("client_reports_client_period").on(t.organisationId, t.clientId, t.periodStart)]);
```

Append to `packages/db/src/schema/index.ts`:
```ts
export * from "./billing.js";
export * from "./ads.js";
export * from "./reports.js";
```

- [ ] **Step 5: Generate and apply the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/drizzle/0006_*.sql`. Read it and confirm it only creates the eight new tables, their enums and their unique indexes — no drops, no alterations to Plan 2/3/4 tables. Then:

Run: `pnpm db:up && pnpm db:migrate`
Expected: `0006` applied.

- [ ] **Step 6: Run the test**

Run: `pnpm --filter @launchos/db test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0006 for subscriptions, invoices, payments, ad accounts, snapshots, reports"
```

---

### Task 2: Payments adapter (mock-first, Stripe when configured)

**Files:**
- Create: `packages/integrations/src/payments/types.ts`, `mock.ts`, `stripe.ts`, `index.ts`
- Modify: `packages/integrations/src/index.ts`, `packages/integrations/package.json`
- Test: `packages/integrations/src/payments/payments.test.ts`

**Interfaces:**
- Produces:
  - `PaymentsAdapter { readonly name: "mock" | "stripe"; createCustomer(input): Promise<PaymentsCustomer>; createSubscription(input): Promise<{ subscription: PaymentsSubscription; invoice: PaymentsInvoice }>; cancelSubscription(subscriptionId: string): Promise<PaymentsSubscription>; listInvoices(customerId: string): Promise<PaymentsInvoice[]>; webhookVerify(rawBody: string, signature: string): PaymentsWebhookEvent }`
  - `MockPaymentsAdapter` with the extra test affordance `advancePeriod(subscriptionId: string): PaymentsInvoice`
  - `StripePaymentsAdapter`, `createPaymentsAdapter(env: NodeJS.ProcessEnv): PaymentsAdapter`
  - DTOs `PaymentsCustomer`, `PaymentsSubscription`, `PaymentsInvoice`, `PaymentsWebhookEvent`

- [ ] **Step 1: Add the Stripe dependency**

In `packages/integrations/package.json` set `"dependencies": { "stripe": "^19.4.0" }` and add `"zod": "^4.4.3"`.

Run: `pnpm install`
Expected: `stripe` resolves in `packages/integrations`.

- [ ] **Step 2: Write the failing adapter test**

`packages/integrations/src/payments/payments.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MockPaymentsAdapter, createPaymentsAdapter } from "./index.js";

const period = new Date("2026-09-01T00:00:00Z");

describe("MockPaymentsAdapter", () => {
  it("issues mock_ ids and one invoice per subscription", async () => {
    const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });
    const customer = await payments.createCustomer({ name: "Grays CabLine", email: "info@grayscabline.co.uk", clientRef: "grays-cabline" });
    expect(customer.id).toMatch(/^mock_cus_/);

    const { subscription, invoice } = await payments.createSubscription({
      customerId: customer.id, amountPence: 29900, currency: "GBP", description: "Growth package", periodStart: period,
    });
    expect(subscription.id).toMatch(/^mock_sub_/);
    expect(subscription.status).toBe("active");
    expect(subscription.currentPeriodEnd > subscription.currentPeriodStart).toBe(true);
    expect(invoice.id).toMatch(/^mock_in_/);
    expect(invoice.subtotalPence).toBe(29900);
    expect(invoice.vatPence).toBe(5980);
    expect(invoice.totalPence).toBe(35880);
    expect(await payments.listInvoices(customer.id)).toHaveLength(1);
  });

  it("generates a further invoice on advancePeriod and rolls the period forward", async () => {
    const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });
    const customer = await payments.createCustomer({ name: "C", clientRef: "c" });
    const { subscription } = await payments.createSubscription({
      customerId: customer.id, amountPence: 10000, currency: "GBP", description: "P", periodStart: period,
    });
    const second = payments.advancePeriod(subscription.id);
    expect(second.id).not.toBe(subscription.id);
    expect(await payments.listInvoices(customer.id)).toHaveLength(2);
    const cancelled = await payments.cancelSubscription(subscription.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("verifies a mock webhook body and rejects a bad signature", () => {
    const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "mock_in_1" } } });
    expect(payments.webhookVerify(body, "mock").type).toBe("invoice.paid");
    expect(() => payments.webhookVerify(body, "nope")).toThrow(/signature/i);
  });
});

describe("createPaymentsAdapter", () => {
  it("returns the mock adapter when Stripe is not configured", () => {
    expect(createPaymentsAdapter({ PAYMENTS_ADAPTER: "stripe" } as NodeJS.ProcessEnv).name).toBe("mock");
    expect(createPaymentsAdapter({} as NodeJS.ProcessEnv).name).toBe("mock");
  });

  it("returns the Stripe adapter when the secret key is present", () => {
    const env = { PAYMENTS_ADAPTER: "stripe", STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: "whsec_123" } as unknown as NodeJS.ProcessEnv;
    expect(createPaymentsAdapter(env).name).toBe("stripe");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @launchos/integrations test`
Expected: FAIL — `Cannot find module './index.js'` under `src/payments`.

- [ ] **Step 4: Write the types**

`packages/integrations/src/payments/types.ts`:
```ts
export type PaymentsSubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "paused";
export type PaymentsInvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

export interface PaymentsCustomer {
  id: string;
  name: string;
  email?: string;
}

export interface PaymentsSubscription {
  id: string;
  customerId: string;
  status: PaymentsSubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  amountPence: number;
  currency: string;
}

export interface PaymentsInvoice {
  id: string;
  customerId: string;
  subscriptionId?: string;
  status: PaymentsInvoiceStatus;
  issuedAt: Date;
  dueAt: Date;
  subtotalPence: number;
  vatPence: number;
  totalPence: number;
  currency: string;
  hostedUrl?: string;
  pdfUrl?: string;
}

/** A provider webhook, normalised to the two fields the worker branches on. */
export interface PaymentsWebhookEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface CreateCustomerInput {
  name: string;
  email?: string;
  /** The client's slug — carried to the provider as metadata for support lookups. */
  clientRef: string;
}

export interface CreateSubscriptionInput {
  customerId: string;
  amountPence: number;
  currency: string;
  description: string;
  periodStart: Date;
}

export interface PaymentsAdapter {
  readonly name: "mock" | "stripe";
  createCustomer(input: CreateCustomerInput): Promise<PaymentsCustomer>;
  createSubscription(input: CreateSubscriptionInput): Promise<{ subscription: PaymentsSubscription; invoice: PaymentsInvoice }>;
  cancelSubscription(subscriptionId: string): Promise<PaymentsSubscription>;
  listInvoices(customerId: string): Promise<PaymentsInvoice[]>;
  webhookVerify(rawBody: string, signature: string): PaymentsWebhookEvent;
}

export const PAYMENT_TERMS_DEFAULT_DAYS = 14;

export function addMonths(from: Date, months: number): Date {
  const next = new Date(from.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

export function vatOf(subtotalPence: number, vatRatePercent: number): number {
  return Math.round((subtotalPence * vatRatePercent) / 100);
}
```

- [ ] **Step 5: Write the mock adapter**

`packages/integrations/src/payments/mock.ts`:
```ts
import {
  PAYMENT_TERMS_DEFAULT_DAYS, addDays, addMonths, vatOf,
  type CreateCustomerInput, type CreateSubscriptionInput, type PaymentsAdapter,
  type PaymentsCustomer, type PaymentsInvoice, type PaymentsSubscription, type PaymentsWebhookEvent,
} from "./types.js";

export interface MockPaymentsOptions {
  vatRatePercent?: number;
  termsDays?: number;
}

/**
 * In-memory Stripe stand-in. Ids are prefixed `mock_` so a mock id can never be
 * mistaken for a real Stripe id in the database or in a log line.
 */
export class MockPaymentsAdapter implements PaymentsAdapter {
  readonly name = "mock" as const;

  private seq = 0;
  private readonly customers = new Map<string, PaymentsCustomer>();
  private readonly subscriptions = new Map<string, PaymentsSubscription>();
  private readonly invoices = new Map<string, PaymentsInvoice>();
  private readonly vatRatePercent: number;
  private readonly termsDays: number;

  constructor(options: MockPaymentsOptions = {}) {
    this.vatRatePercent = options.vatRatePercent ?? 20;
    this.termsDays = options.termsDays ?? PAYMENT_TERMS_DEFAULT_DAYS;
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `mock_${prefix}_${this.seq}`;
  }

  async createCustomer(input: CreateCustomerInput): Promise<PaymentsCustomer> {
    const customer: PaymentsCustomer = { id: this.id("cus"), name: input.name, email: input.email };
    this.customers.set(customer.id, customer);
    return customer;
  }

  async createSubscription(input: CreateSubscriptionInput) {
    const subscription: PaymentsSubscription = {
      id: this.id("sub"),
      customerId: input.customerId,
      status: "active",
      currentPeriodStart: input.periodStart,
      currentPeriodEnd: addMonths(input.periodStart, 1),
      amountPence: input.amountPence,
      currency: input.currency,
    };
    this.subscriptions.set(subscription.id, subscription);
    return { subscription, invoice: this.issueInvoice(subscription) };
  }

  async cancelSubscription(subscriptionId: string): Promise<PaymentsSubscription> {
    const existing = this.subscriptions.get(subscriptionId);
    if (!existing) throw new Error(`mock payments: unknown subscription ${subscriptionId}`);
    const cancelled: PaymentsSubscription = { ...existing, status: "cancelled" };
    this.subscriptions.set(subscriptionId, cancelled);
    return cancelled;
  }

  async listInvoices(customerId: string): Promise<PaymentsInvoice[]> {
    return [...this.invoices.values()].filter((i) => i.customerId === customerId);
  }

  webhookVerify(rawBody: string, signature: string): PaymentsWebhookEvent {
    if (signature !== "mock") throw new Error("mock payments: invalid webhook signature");
    const parsed = JSON.parse(rawBody) as Partial<PaymentsWebhookEvent>;
    if (!parsed.id || !parsed.type) throw new Error("mock payments: webhook body needs id and type");
    return { id: parsed.id, type: parsed.type, data: parsed.data ?? {} };
  }

  /** Test affordance: bills the next period and returns the new invoice. */
  advancePeriod(subscriptionId: string): PaymentsInvoice {
    const existing = this.subscriptions.get(subscriptionId);
    if (!existing) throw new Error(`mock payments: unknown subscription ${subscriptionId}`);
    const rolled: PaymentsSubscription = {
      ...existing,
      currentPeriodStart: existing.currentPeriodEnd,
      currentPeriodEnd: addMonths(existing.currentPeriodEnd, 1),
    };
    this.subscriptions.set(subscriptionId, rolled);
    return this.issueInvoice(rolled);
  }

  private issueInvoice(subscription: PaymentsSubscription): PaymentsInvoice {
    const vatPence = vatOf(subscription.amountPence, this.vatRatePercent);
    const invoice: PaymentsInvoice = {
      id: this.id("in"),
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      status: "sent",
      issuedAt: subscription.currentPeriodStart,
      dueAt: addDays(subscription.currentPeriodStart, this.termsDays),
      subtotalPence: subscription.amountPence,
      vatPence,
      totalPence: subscription.amountPence + vatPence,
      currency: subscription.currency,
    };
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }
}
```

- [ ] **Step 6: Write the Stripe adapter and the factory**

`packages/integrations/src/payments/stripe.ts`:
```ts
import Stripe from "stripe";
import {
  addDays, type CreateCustomerInput, type CreateSubscriptionInput, type PaymentsAdapter,
  type PaymentsCustomer, type PaymentsInvoice, type PaymentsInvoiceStatus,
  type PaymentsSubscription, type PaymentsSubscriptionStatus, type PaymentsWebhookEvent,
} from "./types.js";

export interface StripePaymentsOptions {
  secretKey: string;
  webhookSecret: string;
  termsDays?: number;
}

const SUBSCRIPTION_STATUS: Record<string, PaymentsSubscriptionStatus> = {
  trialing: "trialing", active: "active", past_due: "past_due", unpaid: "past_due",
  canceled: "cancelled", incomplete_expired: "cancelled", paused: "paused", incomplete: "paused",
};

const INVOICE_STATUS: Record<string, PaymentsInvoiceStatus> = {
  draft: "draft", open: "sent", paid: "paid", uncollectible: "overdue", void: "void",
};

export class StripePaymentsAdapter implements PaymentsAdapter {
  readonly name = "stripe" as const;

  private readonly client: Stripe;
  private readonly webhookSecret: string;
  private readonly termsDays: number;

  constructor(options: StripePaymentsOptions) {
    this.client = new Stripe(options.secretKey);
    this.webhookSecret = options.webhookSecret;
    this.termsDays = options.termsDays ?? 14;
  }

  async createCustomer(input: CreateCustomerInput): Promise<PaymentsCustomer> {
    const customer = await this.client.customers.create({
      name: input.name, email: input.email, metadata: { clientRef: input.clientRef },
    });
    return { id: customer.id, name: customer.name ?? input.name, email: customer.email ?? undefined };
  }

  async createSubscription(input: CreateSubscriptionInput) {
    const subscription = await this.client.subscriptions.create({
      customer: input.customerId,
      collection_method: "send_invoice",
      days_until_due: this.termsDays,
      items: [{
        price_data: {
          currency: input.currency.toLowerCase(),
          product_data: { name: input.description },
          recurring: { interval: "month" },
          unit_amount: input.amountPence,
        },
      }],
      expand: ["latest_invoice"],
    });
    const latest = subscription.latest_invoice;
    if (!latest || typeof latest === "string") {
      throw new Error("stripe: subscription created without an expanded latest_invoice");
    }
    return { subscription: this.toSubscription(subscription), invoice: this.toInvoice(latest) };
  }

  async cancelSubscription(subscriptionId: string): Promise<PaymentsSubscription> {
    return this.toSubscription(await this.client.subscriptions.cancel(subscriptionId));
  }

  async listInvoices(customerId: string): Promise<PaymentsInvoice[]> {
    const page = await this.client.invoices.list({ customer: customerId, limit: 100 });
    return page.data.map((invoice) => this.toInvoice(invoice));
  }

  webhookVerify(rawBody: string, signature: string): PaymentsWebhookEvent {
    const event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    return { id: event.id, type: event.type, data: event.data as unknown as Record<string, unknown> };
  }

  private toSubscription(s: Stripe.Subscription): PaymentsSubscription {
    const item = s.items.data[0];
    return {
      id: s.id,
      customerId: typeof s.customer === "string" ? s.customer : s.customer.id,
      status: SUBSCRIPTION_STATUS[s.status] ?? "paused",
      currentPeriodStart: new Date((item?.current_period_start ?? s.start_date) * 1000),
      currentPeriodEnd: new Date((item?.current_period_end ?? s.start_date) * 1000),
      amountPence: item?.price.unit_amount ?? 0,
      currency: (item?.price.currency ?? "gbp").toUpperCase(),
    };
  }

  private toInvoice(i: Stripe.Invoice): PaymentsInvoice {
    const issuedAt = new Date((i.created ?? 0) * 1000);
    return {
      id: i.id ?? "",
      customerId: typeof i.customer === "string" ? i.customer : (i.customer?.id ?? ""),
      subscriptionId: typeof i.parent?.subscription_details?.subscription === "string"
        ? i.parent.subscription_details.subscription
        : undefined,
      status: INVOICE_STATUS[i.status ?? "draft"] ?? "draft",
      issuedAt,
      dueAt: i.due_date ? new Date(i.due_date * 1000) : addDays(issuedAt, this.termsDays),
      subtotalPence: i.subtotal ?? 0,
      vatPence: i.total_taxes?.reduce((sum, t) => sum + t.amount, 0) ?? 0,
      totalPence: i.total ?? 0,
      currency: (i.currency ?? "gbp").toUpperCase(),
      hostedUrl: i.hosted_invoice_url ?? undefined,
      pdfUrl: i.invoice_pdf ?? undefined,
    };
  }
}
```

`packages/integrations/src/payments/index.ts`:
```ts
import { MockPaymentsAdapter } from "./mock.js";
import { StripePaymentsAdapter } from "./stripe.js";
import type { PaymentsAdapter } from "./types.js";

export * from "./types.js";
export { MockPaymentsAdapter } from "./mock.js";
export { StripePaymentsAdapter } from "./stripe.js";

/** VAT rate as a whole-number percentage; UK standard rate when unset. */
export function vatRateFromEnv(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.VAT_RATE);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20;
}

/**
 * Stripe only when it is fully configured. A half-set Stripe environment falls
 * back to the mock rather than failing at boot, so a missing key can never take
 * the whole app down — the adapter in use is shown in Settings → Billing.
 */
export function createPaymentsAdapter(env: NodeJS.ProcessEnv): PaymentsAdapter {
  const termsDays = Number(env.PAYMENT_TERMS_DAYS) || 14;
  if (env.PAYMENTS_ADAPTER === "stripe" && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
    return new StripePaymentsAdapter({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      termsDays,
    });
  }
  return new MockPaymentsAdapter({ vatRatePercent: vatRateFromEnv(env), termsDays });
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @launchos/integrations test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(integrations): payments adapter with mock and Stripe implementations"
```

---

### Task 3: Ads adapter (deterministic mock, credential-gated Google and Meta)

**Files:**
- Create: `packages/integrations/src/ads/types.ts`, `mock.ts`, `google.ts`, `meta.ts`, `index.ts`
- Modify: `packages/integrations/src/index.ts`
- Test: `packages/integrations/src/ads/ads.test.ts`

**Interfaces:**
- Produces:
  - `AdsAdapter { readonly name: "mock" | "google" | "meta"; listAccounts(): Promise<AdAccountSummary[]>; fetchDailyMetrics(accountId: string, date: string): Promise<AdDailyMetrics> }`
  - `MockAdsAdapter(options?: { accounts?: AdAccountSummary[]; dropFrom?: string; dropFactor?: number })`
  - `GoogleAdsAdapter`, `MetaAdsAdapter` (throw on construction without credentials)
  - `createAdsAdapter(env: NodeJS.ProcessEnv): AdsAdapter`
  - `Integrations` gains `payments: PaymentsAdapter` and `ads: AdsAdapter`

- [ ] **Step 1: Write the failing adapter test**

`packages/integrations/src/ads/ads.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { GoogleAdsAdapter, MetaAdsAdapter, MockAdsAdapter, createAdsAdapter } from "./index.js";

describe("MockAdsAdapter", () => {
  it("is deterministic for the same account and date", async () => {
    const a = new MockAdsAdapter();
    const b = new MockAdsAdapter();
    const first = await a.fetchDailyMetrics("acct-1", "2026-09-01");
    const second = await b.fetchDailyMetrics("acct-1", "2026-09-01");
    expect(second).toEqual(first);
  });

  it("varies by account and by date", async () => {
    const ads = new MockAdsAdapter();
    const day1 = await ads.fetchDailyMetrics("acct-1", "2026-09-01");
    const day2 = await ads.fetchDailyMetrics("acct-1", "2026-09-02");
    const other = await ads.fetchDailyMetrics("acct-2", "2026-09-01");
    expect(day2.clicks).not.toBe(day1.clicks);
    expect(other.clicks).not.toBe(day1.clicks);
  });

  it("returns internally consistent figures", async () => {
    const ads = new MockAdsAdapter();
    const m = await ads.fetchDailyMetrics("acct-1", "2026-09-01");
    expect(m.clicks).toBeLessThan(m.impressions);
    expect(m.conversions).toBeLessThanOrEqual(m.clicks);
    expect(m.cpcPence).toBeCloseTo(m.spendPence / m.clicks, 4);
    expect(m.roas).toBeCloseTo(m.conversionValuePence / m.spendPence, 4);
  });

  it("drops ROAS from the configured date onwards", async () => {
    const ads = new MockAdsAdapter({ dropFrom: "2026-09-10" });
    const before = await ads.fetchDailyMetrics("acct-1", "2026-09-09");
    const after = await ads.fetchDailyMetrics("acct-1", "2026-09-10");
    expect(after.roas).toBeLessThan(before.roas * 0.7);
    expect(after.spendPence).toBeGreaterThan(0);
  });

  it("lists its configured accounts", async () => {
    const ads = new MockAdsAdapter({
      accounts: [{ externalId: "123-456-7890", platform: "google", name: "Search", currency: "GBP" }],
    });
    expect(await ads.listAccounts()).toHaveLength(1);
  });
});

describe("real ad adapters", () => {
  it("refuse to construct without credentials", () => {
    expect(() => new GoogleAdsAdapter({})).toThrow(/credentials required/i);
    expect(() => new MetaAdsAdapter({})).toThrow(/credentials required/i);
  });
});

describe("createAdsAdapter", () => {
  it("defaults to the mock adapter", () => {
    expect(createAdsAdapter({} as NodeJS.ProcessEnv).name).toBe("mock");
    expect(createAdsAdapter({ ADS_ADAPTER: "google" } as NodeJS.ProcessEnv).name).toBe("mock");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/integrations test`
Expected: FAIL — `Cannot find module './index.js'` under `src/ads`.

- [ ] **Step 3: Write the types and the mock**

`packages/integrations/src/ads/types.ts`:
```ts
export type AdPlatform = "google" | "meta";

export interface AdAccountSummary {
  externalId: string;
  platform: AdPlatform;
  name: string;
  currency: string;
}

export interface AdDailyMetrics {
  date: string;
  spendPence: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValuePence: number;
  cpcPence: number;
  roas: number;
}

export interface AdsAdapter {
  readonly name: "mock" | "google" | "meta";
  listAccounts(): Promise<AdAccountSummary[]>;
  /** `date` is an ISO calendar date, `YYYY-MM-DD`. */
  fetchDailyMetrics(accountId: string, date: string): Promise<AdDailyMetrics>;
}
```

`packages/integrations/src/ads/mock.ts`:
```ts
import type { AdAccountSummary, AdDailyMetrics, AdsAdapter } from "./types.js";

export interface MockAdsOptions {
  accounts?: AdAccountSummary[];
  /** ISO date from which conversions are scaled down, to simulate a ROAS slide. */
  dropFrom?: string;
  dropFactor?: number;
}

/** FNV-1a, 32 bit. Stable across runs and platforms — no Math.random anywhere. */
function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A stable pseudo-random number in [0, 1) for a seed string. */
function unit(seed: string): number {
  return hash32(seed) / 0x1_0000_0000;
}

export class MockAdsAdapter implements AdsAdapter {
  readonly name = "mock" as const;

  private readonly accounts: AdAccountSummary[];
  private readonly dropFrom?: string;
  private readonly dropFactor: number;

  constructor(options: MockAdsOptions = {}) {
    this.accounts = options.accounts ?? [];
    this.dropFrom = options.dropFrom;
    this.dropFactor = options.dropFactor ?? 0.45;
  }

  async listAccounts(): Promise<AdAccountSummary[]> {
    return this.accounts;
  }

  async fetchDailyMetrics(accountId: string, date: string): Promise<AdDailyMetrics> {
    const seed = (suffix: string) => unit(`${accountId}:${date}:${suffix}`);
    const impressions = 4000 + Math.round(seed("impressions") * 4000);
    const clicks = Math.max(1, Math.round(impressions * (0.03 + seed("ctr") * 0.02)));
    const spendPence = Math.round(clicks * (70 + seed("cpc") * 60));
    const factor = this.dropFrom && date >= this.dropFrom ? this.dropFactor : 1;
    const conversions = Math.round(clicks * (0.06 + seed("cvr") * 0.04) * factor);
    const conversionValuePence = Math.round(conversions * (4500 + seed("aov") * 2000));
    return {
      date,
      spendPence,
      impressions,
      clicks,
      conversions,
      conversionValuePence,
      cpcPence: spendPence / clicks,
      roas: spendPence === 0 ? 0 : conversionValuePence / spendPence,
    };
  }
}
```

- [ ] **Step 4: Write the credential-gated real adapters and the factory**

`packages/integrations/src/ads/google.ts`:
```ts
import type { AdAccountSummary, AdDailyMetrics, AdsAdapter } from "./types.js";

export interface GoogleAdsCredentials {
  developerToken?: string;
  customerId?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

const NOT_IMPLEMENTED =
  "GoogleAdsAdapter is an interface-only adapter: wire the Google Ads API client once real credentials exist. Use ADS_ADAPTER=mock until then.";

/**
 * Interface-complete Google Ads adapter. It refuses to construct without
 * credentials and never invents numbers — a client-facing ad report built on
 * fabricated spend would be worse than no report at all.
 */
export class GoogleAdsAdapter implements AdsAdapter {
  readonly name = "google" as const;

  constructor(private readonly credentials: GoogleAdsCredentials) {
    const missing = (["developerToken", "customerId", "clientId", "clientSecret", "refreshToken"] as const)
      .filter((key) => !credentials[key]);
    if (missing.length > 0) {
      throw new Error(`GoogleAdsAdapter credentials required: missing ${missing.join(", ")}`);
    }
  }

  async listAccounts(): Promise<AdAccountSummary[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async fetchDailyMetrics(_accountId: string, _date: string): Promise<AdDailyMetrics> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
```

`packages/integrations/src/ads/meta.ts`: identical shape — `MetaAdsAdapter`, `readonly name = "meta" as const`, `MetaAdsCredentials { accessToken?: string; adAccountId?: string; appSecret?: string }`, required keys `["accessToken", "adAccountId", "appSecret"]`, error prefix `MetaAdsAdapter credentials required: missing …`, and a `NOT_IMPLEMENTED` message naming the Meta Marketing API.

`packages/integrations/src/ads/index.ts`:
```ts
import { MockAdsAdapter } from "./mock.js";
import type { AdsAdapter } from "./types.js";

export * from "./types.js";
export { MockAdsAdapter } from "./mock.js";
export { GoogleAdsAdapter } from "./google.js";
export { MetaAdsAdapter } from "./meta.js";

/**
 * Only the mock is selectable today. `ADS_ADAPTER=google|meta` is accepted but
 * still returns the mock, because constructing a real adapter without
 * credentials throws and would take the worker down at boot. Swap this branch
 * for a credential check when Google Ads and Meta credentials are supplied.
 */
export function createAdsAdapter(env: NodeJS.ProcessEnv): AdsAdapter {
  return new MockAdsAdapter({ dropFrom: env.MOCK_ADS_DROP_FROM });
}
```

Extend `packages/integrations/src/index.ts`:
```ts
import { HttpUptimeProbe, MockUptimeProbe, type UptimeProbe } from "./uptime/index.js";
import { MockHostingProvider, type HostingProvider } from "./coolify/index.js";
import { createPaymentsAdapter, type PaymentsAdapter } from "./payments/index.js";
import { createAdsAdapter, type AdsAdapter } from "./ads/index.js";

export * from "./uptime/index.js";
export * from "./coolify/index.js";
export * from "./payments/index.js";
export * from "./ads/index.js";

export interface Integrations {
  uptime: UptimeProbe;
  hosting: HostingProvider;
  payments: PaymentsAdapter;
  ads: AdsAdapter;
}
```
Keep `parseDownUrls` as it is and extend `createIntegrations` to return `{ uptime, hosting, payments: createPaymentsAdapter(env), ads: createAdsAdapter(env) }`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @launchos/integrations test && pnpm --filter @launchos/integrations typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(integrations): deterministic mock ads adapter and credential-gated Google/Meta adapters"
```

---

### Task 4: Core — subscriptions

**Files:**
- Create: `packages/core/src/billing/subscriptions.ts`
- Modify: `packages/core/package.json`, `packages/core/src/index.ts`
- Test: `packages/core/src/billing/subscriptions.test.ts`

**Interfaces:**
- Consumes: `assertOwned` (P2), `recordAudit`, `recordActivity` (P2), `schema.billingProfiles` (P2), `schema.packages` (P3), `PaymentsAdapter` / `MockPaymentsAdapter` from `@launchos/integrations`.
- Produces:
  - `createSubscription(db, organisationId, input, payments: PaymentsAdapter)` → `{ subscription, providerInvoice }`
  - `cancelSubscription(db, organisationId, { subscriptionId, actorKind?, actorId? }, payments: PaymentsAdapter)` → the cancelled `subscriptions` row
  - `activeSubscriptionForClient(db, organisationId, clientId)` → the client's `trialing | active | past_due` subscription or `undefined`

Adapters are injected as a trailing argument rather than read from env inside `core`: `CLAUDE.md` rule 4 keeps adapter selection in `createIntegrations(env)`, and the tests must be able to pass a mock.

- [ ] **Step 1: Add the integrations and channels dependencies to core**

In `packages/core/package.json`, add to `dependencies`: `"@launchos/integrations": "workspace:*"` and `"@launchos/channels": "workspace:*"`.

Run: `pnpm install`
Expected: both workspace links resolve.

- [ ] **Step 2: Write the failing test**

`packages/core/src/billing/subscriptions.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { activeSubscriptionForClient, cancelSubscription, createSubscription } from "./subscriptions.js";

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sub-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}`, email: "info@grays.test" })
    .returning();
  await db.insert(schema.billingProfiles)
    .values({ organisationId: org!.id, clientId: client!.id, billingName: "Grays CabLine Ltd" });
  const [pkg] = await db.insert(schema.packages)
    .values({ organisationId: org!.id, name: "Growth", slug: `growth-${randomUUID()}`, monthlyPricePence: 29900, setupPricePence: 0 })
    .returning();
  return { orgId: org!.id, clientId: client!.id, packageId: pkg!.id };
}

describe("createSubscription", () => {
  it("creates the provider customer, stores its id on the billing profile and returns the first invoice", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, packageId } = await fixture(db);
      const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });

      const { subscription, providerInvoice } = await createSubscription(
        db, orgId,
        { clientId, packageId, periodStart: new Date("2026-09-01T00:00:00Z"), actorKind: "user", actorId: "u1" },
        payments,
      );

      expect(subscription.status).toBe("active");
      expect(subscription.amountPence).toBe(29900);
      expect(subscription.stripeSubscriptionId).toMatch(/^mock_sub_/);
      expect(providerInvoice.totalPence).toBe(35880);

      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, clientId));
      expect(profile!.stripeCustomerId).toMatch(/^mock_cus_/);

      const found = await activeSubscriptionForClient(db, orgId, clientId);
      expect(found?.id).toBe(subscription.id);
    });
  });

  it("reuses an existing provider customer id", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, packageId } = await fixture(db);
      await db.update(schema.billingProfiles)
        .set({ stripeCustomerId: "mock_cus_existing" })
        .where(eq(schema.billingProfiles.clientId, clientId));

      await createSubscription(db, orgId, { clientId, packageId, periodStart: new Date("2026-09-01T00:00:00Z") }, new MockPaymentsAdapter());

      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, clientId));
      expect(profile!.stripeCustomerId).toBe("mock_cus_existing");
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const { clientId, packageId } = await fixture(db);
      const [other] = await db.insert(schema.organisations).values({ name: "O", slug: `oth-${randomUUID()}` }).returning();
      await expect(
        createSubscription(db, other!.id, { clientId, packageId, periodStart: new Date() }, new MockPaymentsAdapter()),
      ).rejects.toThrow(/not found in organisation/);
    });
  });
});

describe("cancelSubscription", () => {
  it("cancels at the provider and locally", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, packageId } = await fixture(db);
      const payments = new MockPaymentsAdapter();
      const { subscription } = await createSubscription(db, orgId, { clientId, packageId, periodStart: new Date() }, payments);

      const cancelled = await cancelSubscription(db, orgId, { subscriptionId: subscription.id, actorKind: "user", actorId: "u1" }, payments);

      expect(cancelled.status).toBe("cancelled");
      expect(await activeSubscriptionForClient(db, orgId, clientId)).toBeUndefined();
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @launchos/core test -- subscriptions`
Expected: FAIL — `Cannot find module './subscriptions.js'`.

- [ ] **Step 4: Implement**

`packages/core/src/billing/subscriptions.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsAdapter, PaymentsInvoice } from "@launchos/integrations";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const ACTIVE_STATUSES = ["trialing", "active", "past_due"] as const;

export const CreateSubscriptionServiceInput = z.object({
  clientId: z.string().uuid(),
  packageId: z.string().uuid(),
  periodStart: z.date().default(() => new Date()),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateSubscriptionServiceInput = z.input<typeof CreateSubscriptionServiceInput>;

export async function createSubscription(
  db: Db,
  organisationId: string,
  input: CreateSubscriptionServiceInput,
  payments: PaymentsAdapter,
): Promise<{ subscription: typeof schema.subscriptions.$inferSelect; providerInvoice: PaymentsInvoice }> {
  const v = CreateSubscriptionServiceInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  await assertOwned(db, organisationId, schema.packages, v.packageId);

  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, v.clientId));
  const [pkg] = await db.select().from(schema.packages).where(eq(schema.packages.id, v.packageId));
  const [profile] = await db.select().from(schema.billingProfiles).where(and(
    eq(schema.billingProfiles.organisationId, organisationId),
    eq(schema.billingProfiles.clientId, v.clientId),
  ));
  if (!profile) throw new Error(`client ${v.clientId} has no billing profile`);

  // The provider round trip happens before the transaction: an HTTP call must
  // never hold a database transaction open, and a failure here should leave no
  // local rows behind at all.
  const customerId = profile.stripeCustomerId
    ?? (await payments.createCustomer({
      name: profile.billingName ?? client!.name,
      email: client!.email ?? undefined,
      clientRef: client!.slug,
    })).id;

  const created = await payments.createSubscription({
    customerId,
    amountPence: pkg!.monthlyPricePence,
    currency: pkg!.currency,
    description: `${pkg!.name} — monthly retainer`,
    periodStart: v.periodStart,
  });

  const subscription = await db.transaction(async (tx) => {
    if (!profile.stripeCustomerId) {
      await tx.update(schema.billingProfiles)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(schema.billingProfiles.id, profile.id));
    }
    const [row] = await tx.insert(schema.subscriptions).values({
      organisationId,
      clientId: v.clientId,
      packageId: v.packageId,
      stripeSubscriptionId: created.subscription.id,
      status: created.subscription.status,
      currentPeriodStart: created.subscription.currentPeriodStart,
      currentPeriodEnd: created.subscription.currentPeriodEnd,
      amountPence: created.subscription.amountPence,
      currency: created.subscription.currency,
    }).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "subscription.created",
      targetType: "subscription", targetId: row!.id, after: row,
    });
    return row!;
  });

  await recordActivity(db, organisationId, {
    clientId: v.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "subscription.created",
    title: `Subscription started on ${pkg!.name}`,
    body: `£${(pkg!.monthlyPricePence / 100).toFixed(2)} per month via ${payments.name}.`,
    link: `/clients/${v.clientId}/billing`,
  });

  return { subscription, providerInvoice: created.invoice };
}

export const CancelSubscriptionInput = z.object({
  subscriptionId: z.string().uuid(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CancelSubscriptionInput = z.input<typeof CancelSubscriptionInput>;

export async function cancelSubscription(
  db: Db,
  organisationId: string,
  input: CancelSubscriptionInput,
  payments: PaymentsAdapter,
) {
  const v = CancelSubscriptionInput.parse(input);
  await assertOwned(db, organisationId, schema.subscriptions, v.subscriptionId);
  const [before] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, v.subscriptionId));
  if (before!.stripeSubscriptionId) await payments.cancelSubscription(before!.stripeSubscriptionId);

  const [after] = await db.update(schema.subscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(schema.subscriptions.id, v.subscriptionId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "subscription.cancelled",
    targetType: "subscription", targetId: v.subscriptionId, before, after,
  });
  await recordActivity(db, organisationId, {
    clientId: after!.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "subscription.cancelled",
    title: "Subscription cancelled", link: `/clients/${after!.clientId}/billing`,
  });
  return after!;
}

export async function activeSubscriptionForClient(db: Db, organisationId: string, clientId: string) {
  const [row] = await db.select().from(schema.subscriptions).where(and(
    eq(schema.subscriptions.organisationId, organisationId),
    eq(schema.subscriptions.clientId, clientId),
    inArray(schema.subscriptions.status, [...ACTIVE_STATUSES]),
    isNull(schema.subscriptions.deletedAt),
  )).orderBy(schema.subscriptions.createdAt).limit(1);
  return row;
}
```

Add to `packages/core/src/index.ts`:
```ts
export {
  createSubscription, cancelSubscription, activeSubscriptionForClient,
  CreateSubscriptionServiceInput, CancelSubscriptionInput,
} from "./billing/subscriptions.js";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @launchos/core test -- subscriptions`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): subscriptions service backed by the payments adapter"
```

---

### Task 5: Core — invoice numbering, invoice lifecycle and overdue detection

**Files:**
- Create: `packages/core/src/billing/invoice-number.ts`, `packages/core/src/billing/invoices.ts`, `packages/core/src/billing/overdue.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/billing/invoices.test.ts`, `packages/core/src/billing/overdue.test.ts`

**Interfaces:**
- Consumes: `assertOwned`, `recordAudit`, `recordActivity`, `notifyOwner` (P2), `createTicket` (P1/P4), `schema.billingProfiles.paymentTermsDays` (P2).
- Produces:
  - `nextInvoiceNumber(db, organisationId, year: number): Promise<string>` → `LF-2026-0001`
  - `createInvoiceFromSubscription(db, organisationId, { subscriptionId, issuedAt?, vatRatePercent?, termsDays?, actorKind?, actorId? })` → the `invoices` row
  - `markInvoiceSent`, `markInvoicePaid`, `voidInvoice` — each `(db, organisationId, { invoiceId, ... })`
  - `findOverdueInvoices(db, organisationId, { now })` → `{ invoice, ticketId }[]`
  - `VAT_RATE_DEFAULT_PERCENT = 20`, `PAYMENT_TERMS_DEFAULT_DAYS = 14`

- [ ] **Step 1: Write the failing invoice test**

`packages/core/src/billing/invoices.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { createSubscription } from "./subscriptions.js";
import { nextInvoiceNumber } from "./invoice-number.js";
import { createInvoiceFromSubscription, markInvoicePaid, markInvoiceSent, voidInvoice } from "./invoices.js";

async function subscribed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `inv-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  await db.insert(schema.billingProfiles)
    .values({ organisationId: org!.id, clientId: client!.id, billingName: "Grays Ltd", paymentTermsDays: 14 });
  const [pkg] = await db.insert(schema.packages)
    .values({ organisationId: org!.id, name: "Growth", slug: `g-${randomUUID()}`, monthlyPricePence: 29900, setupPricePence: 0 }).returning();
  const { subscription } = await createSubscription(
    db, org!.id,
    { clientId: client!.id, packageId: pkg!.id, periodStart: new Date("2026-09-01T00:00:00Z") },
    new MockPaymentsAdapter(),
  );
  return { orgId: org!.id, clientId: client!.id, subscription };
}

describe("nextInvoiceNumber", () => {
  it("allocates sequential numbers per organisation and year", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(schema.organisations).values({ name: "A", slug: `a-${randomUUID()}` }).returning();
      const [b] = await db.insert(schema.organisations).values({ name: "B", slug: `b-${randomUUID()}` }).returning();
      expect(await nextInvoiceNumber(db, a!.id, 2026)).toBe("LF-2026-0001");
      expect(await nextInvoiceNumber(db, a!.id, 2026)).toBe("LF-2026-0002");
      expect(await nextInvoiceNumber(db, a!.id, 2027)).toBe("LF-2027-0001");
      expect(await nextInvoiceNumber(db, b!.id, 2026)).toBe("LF-2026-0001");
    });
  });
});

describe("createInvoiceFromSubscription", () => {
  it("bills the subscription period with VAT and the client's payment terms", async () => {
    await withTestDb(async (db) => {
      const { orgId, subscription } = await subscribed(db);

      const invoice = await createInvoiceFromSubscription(db, orgId, {
        subscriptionId: subscription.id, issuedAt: new Date("2026-09-01T00:00:00Z"), vatRatePercent: 20,
      });

      expect(invoice.number).toBe("LF-2026-0001");
      expect(invoice.status).toBe("draft");
      expect(invoice.subtotalPence).toBe(29900);
      expect(invoice.vatPence).toBe(5980);
      expect(invoice.totalPence).toBe(35880);
      expect(invoice.dueAt.toISOString()).toBe("2026-09-15T00:00:00.000Z");
      expect(invoice.lineItems).toHaveLength(1);
      expect(invoice.lineItems[0]!.unitPence).toBe(29900);
    });
  });

  it("moves a draft through sent to paid and records the audit trail", async () => {
    await withTestDb(async (db) => {
      const { orgId, subscription } = await subscribed(db);
      const invoice = await createInvoiceFromSubscription(db, orgId, { subscriptionId: subscription.id });

      const sent = await markInvoiceSent(db, orgId, { invoiceId: invoice.id, actorKind: "user", actorId: "u1" });
      expect(sent.status).toBe("sent");

      const paid = await markInvoicePaid(db, orgId, {
        invoiceId: invoice.id, paidAt: new Date("2026-09-10T00:00:00Z"), actorKind: "user", actorId: "u1",
      });
      expect(paid.status).toBe("paid");
      expect(paid.paidAt?.toISOString()).toBe("2026-09-10T00:00:00.000Z");

      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, invoice.id));
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining(["invoice.created", "invoice.sent", "invoice.paid"]),
      );
    });
  });

  it("refuses to void a paid invoice", async () => {
    await withTestDb(async (db) => {
      const { orgId, subscription } = await subscribed(db);
      const invoice = await createInvoiceFromSubscription(db, orgId, { subscriptionId: subscription.id });
      await markInvoicePaid(db, orgId, { invoiceId: invoice.id });
      await expect(voidInvoice(db, orgId, { invoiceId: invoice.id })).rejects.toThrow(/paid/i);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/core test -- invoices`
Expected: FAIL — `Cannot find module './invoice-number.js'`.

- [ ] **Step 3: Implement numbering**

`packages/core/src/billing/invoice-number.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { sql } from "drizzle-orm";

export const INVOICE_NUMBER_PREFIX = "LF";

/**
 * Allocates the next invoice number for an organisation and year.
 *
 * One upserting statement, so two concurrent invoices serialise on the
 * sequence row's lock instead of racing a read-modify-write and colliding on
 * the unique (organisation_id, number) index.
 */
export async function nextInvoiceNumber(db: Db, organisationId: string, year: number): Promise<string> {
  const [row] = await db
    .insert(schema.invoiceSequences)
    .values({ organisationId, year, nextNumber: 1 })
    .onConflictDoUpdate({
      target: [schema.invoiceSequences.organisationId, schema.invoiceSequences.year],
      set: { nextNumber: sql`${schema.invoiceSequences.nextNumber} + 1`, updatedAt: new Date() },
    })
    .returning({ nextNumber: schema.invoiceSequences.nextNumber });
  return `${INVOICE_NUMBER_PREFIX}-${year}-${String(row!.nextNumber).padStart(4, "0")}`;
}
```

- [ ] **Step 4: Implement the invoice lifecycle**

`packages/core/src/billing/invoices.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { InvoiceLineItem } from "@launchos/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { nextInvoiceNumber } from "./invoice-number.js";

export const VAT_RATE_DEFAULT_PERCENT = 20;
export const PAYMENT_TERMS_DEFAULT_DAYS = 14;

const ActorKind = z.enum(["user", "client", "agent", "system"]);
type ActorKind = z.infer<typeof ActorKind>;

export const CreateInvoiceFromSubscriptionInput = z.object({
  subscriptionId: z.string().uuid(),
  issuedAt: z.date().optional(),
  vatRatePercent: z.number().min(0).max(100).default(VAT_RATE_DEFAULT_PERCENT),
  termsDays: z.number().int().min(0).optional(),
  actorKind: ActorKind.default("system"),
  actorId: z.string().optional(),
});
export type CreateInvoiceFromSubscriptionInput = z.input<typeof CreateInvoiceFromSubscriptionInput>;

export async function createInvoiceFromSubscription(db: Db, organisationId: string, input: CreateInvoiceFromSubscriptionInput) {
  const v = CreateInvoiceFromSubscriptionInput.parse(input);
  await assertOwned(db, organisationId, schema.subscriptions, v.subscriptionId);

  const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, v.subscriptionId));
  const [pkg] = subscription!.packageId
    ? await db.select().from(schema.packages).where(eq(schema.packages.id, subscription!.packageId))
    : [undefined];
  const [profile] = await db.select().from(schema.billingProfiles).where(and(
    eq(schema.billingProfiles.organisationId, organisationId),
    eq(schema.billingProfiles.clientId, subscription!.clientId),
  ));

  const issuedAt = v.issuedAt ?? subscription!.currentPeriodStart;
  const termsDays = v.termsDays ?? profile?.paymentTermsDays ?? PAYMENT_TERMS_DEFAULT_DAYS;
  const dueAt = new Date(issuedAt.getTime() + termsDays * 86_400_000);
  const subtotalPence = subscription!.amountPence;
  const vatPence = Math.round((subtotalPence * v.vatRatePercent) / 100);
  const lineItems: InvoiceLineItem[] = [{
    description: `${pkg?.name ?? "Monthly retainer"} — ${issuedAt.toISOString().slice(0, 7)}`,
    quantity: 1,
    unitPence: subtotalPence,
  }];

  const invoice = await db.transaction(async (tx) => {
    const number = await nextInvoiceNumber(tx as unknown as Db, organisationId, issuedAt.getUTCFullYear());
    const [row] = await tx.insert(schema.invoices).values({
      organisationId,
      clientId: subscription!.clientId,
      subscriptionId: subscription!.id,
      number,
      issuedAt,
      dueAt,
      subtotalPence,
      vatPence,
      totalPence: subtotalPence + vatPence,
      currency: subscription!.currency,
      lineItems,
    }).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "invoice.created",
      targetType: "invoice", targetId: row!.id, after: row,
    });
    return row!;
  });

  await recordActivity(db, organisationId, {
    clientId: invoice.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "invoice.created",
    title: `Invoice ${invoice.number} raised`,
    body: `£${(invoice.totalPence / 100).toFixed(2)} due ${invoice.dueAt.toISOString().slice(0, 10)}.`,
    link: `/invoices/${invoice.id}`,
  });
  return invoice;
}

const InvoiceActionInput = z.object({
  invoiceId: z.string().uuid(),
  actorKind: ActorKind.default("system"),
  actorId: z.string().optional(),
});

async function transition(
  db: Db,
  organisationId: string,
  invoiceId: string,
  action: string,
  patch: Partial<typeof schema.invoices.$inferInsert>,
  actorKind: ActorKind,
  actorId: string | undefined,
) {
  await assertOwned(db, organisationId, schema.invoices, invoiceId);
  const [before] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  const [after] = await db.update(schema.invoices)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.invoices.id, invoiceId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind, actorId, action, targetType: "invoice", targetId: invoiceId, before, after,
  });
  return after!;
}

export async function markInvoiceSent(db: Db, organisationId: string, input: z.input<typeof InvoiceActionInput>) {
  const v = InvoiceActionInput.parse(input);
  return transition(db, organisationId, v.invoiceId, "invoice.sent", { status: "sent" }, v.actorKind, v.actorId);
}

export const MarkInvoicePaidInput = InvoiceActionInput.extend({ paidAt: z.date().optional() });
export type MarkInvoicePaidInput = z.input<typeof MarkInvoicePaidInput>;

export async function markInvoicePaid(db: Db, organisationId: string, input: MarkInvoicePaidInput) {
  const v = MarkInvoicePaidInput.parse(input);
  return transition(
    db, organisationId, v.invoiceId, "invoice.paid",
    { status: "paid", paidAt: v.paidAt ?? new Date() }, v.actorKind, v.actorId,
  );
}

export async function voidInvoice(db: Db, organisationId: string, input: z.input<typeof InvoiceActionInput>) {
  const v = InvoiceActionInput.parse(input);
  await assertOwned(db, organisationId, schema.invoices, v.invoiceId);
  const [existing] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, v.invoiceId));
  // Voiding a settled invoice would silently unbalance the ledger; a refund is
  // recorded as a payment instead.
  if (existing!.status === "paid") throw new Error(`invoice ${existing!.number} is paid and cannot be voided`);
  return transition(db, organisationId, v.invoiceId, "invoice.voided", { status: "void" }, v.actorKind, v.actorId);
}
```

Add to `packages/core/src/index.ts`:
```ts
export { nextInvoiceNumber, INVOICE_NUMBER_PREFIX } from "./billing/invoice-number.js";
export {
  createInvoiceFromSubscription, markInvoiceSent, markInvoicePaid, voidInvoice,
  CreateInvoiceFromSubscriptionInput, MarkInvoicePaidInput,
  VAT_RATE_DEFAULT_PERCENT, PAYMENT_TERMS_DEFAULT_DAYS,
} from "./billing/invoices.js";
```

- [ ] **Step 5: Run the invoice tests**

Run: `pnpm --filter @launchos/core test -- invoices`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the failing overdue test**

`packages/core/src/billing/overdue.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { createSubscription } from "./subscriptions.js";
import { createInvoiceFromSubscription, markInvoiceSent } from "./invoices.js";
import { findOverdueInvoices } from "./overdue.js";

describe("findOverdueInvoices", () => {
  it("flips a sent, past-due invoice to overdue, raises one billing ticket and notifies the owner", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `od-${randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
      await db.insert(schema.billingProfiles).values({ organisationId: org!.id, clientId: client!.id, billingName: "Grays Ltd" });
      const [pkg] = await db.insert(schema.packages)
        .values({ organisationId: org!.id, name: "Growth", slug: `g-${randomUUID()}`, monthlyPricePence: 29900, setupPricePence: 0 }).returning();
      const { subscription } = await createSubscription(
        db, org!.id, { clientId: client!.id, packageId: pkg!.id, periodStart: new Date("2026-08-01T00:00:00Z") },
        new MockPaymentsAdapter(),
      );
      const invoice = await createInvoiceFromSubscription(db, org!.id, {
        subscriptionId: subscription.id, issuedAt: new Date("2026-08-01T00:00:00Z"),
      });
      await markInvoiceSent(db, org!.id, { invoiceId: invoice.id });

      const now = new Date("2026-09-04T07:30:00Z");
      const first = await findOverdueInvoices(db, org!.id, { now });
      expect(first).toHaveLength(1);
      expect(first[0]!.invoice.status).toBe("overdue");

      const tickets = await db.select().from(schema.tickets).where(and(
        eq(schema.tickets.organisationId, org!.id),
        eq(schema.tickets.category, "billing"),
      ));
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.subject).toContain(invoice.number);

      const notifications = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.organisationId, org!.id));
      expect(notifications.length).toBeGreaterThan(0);

      // Idempotent: a second sweep neither re-flags nor re-tickets.
      expect(await findOverdueInvoices(db, org!.id, { now })).toHaveLength(0);
      const ticketsAgain = await db.select().from(schema.tickets).where(and(
        eq(schema.tickets.organisationId, org!.id),
        eq(schema.tickets.category, "billing"),
      ));
      expect(ticketsAgain).toHaveLength(1);
    });
  });

  it("ignores drafts, paid and voided invoices", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `od2-${randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
      const base = {
        organisationId: org!.id, clientId: client!.id,
        issuedAt: new Date("2026-08-01T00:00:00Z"), dueAt: new Date("2026-08-15T00:00:00Z"),
        subtotalPence: 100, vatPence: 20, totalPence: 120,
      };
      await db.insert(schema.invoices).values([
        { ...base, number: "LF-2026-9001", status: "draft" as const },
        { ...base, number: "LF-2026-9002", status: "paid" as const },
        { ...base, number: "LF-2026-9003", status: "void" as const },
      ]);
      expect(await findOverdueInvoices(db, org!.id, { now: new Date("2026-09-04T00:00:00Z") })).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 7: Run it to verify it fails, then implement the sweep**

Run: `pnpm --filter @launchos/core test -- overdue`
Expected: FAIL — `Cannot find module './overdue.js'`.

`packages/core/src/billing/overdue.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { createTicket } from "../support/create-ticket.js";

export const FindOverdueInvoicesInput = z.object({ now: z.date().default(() => new Date()) });
export type FindOverdueInvoicesInput = z.input<typeof FindOverdueInvoicesInput>;

export interface OverdueOutcome {
  invoice: typeof schema.invoices.$inferSelect;
  ticketId: string;
}

/**
 * Flips every sent invoice whose due date has passed to `overdue`, raises one
 * billing ticket per invoice and notifies the owner once. The ticket id lands
 * on the invoice's metadata and the status moves off `sent`, so the daily
 * sweep is idempotent: an already-overdue invoice is never re-ticketed.
 */
export async function findOverdueInvoices(
  db: Db,
  organisationId: string,
  input: FindOverdueInvoicesInput,
): Promise<OverdueOutcome[]> {
  const v = FindOverdueInvoicesInput.parse(input);
  const due = await db.select().from(schema.invoices).where(and(
    eq(schema.invoices.organisationId, organisationId),
    eq(schema.invoices.status, "sent"),
    lt(schema.invoices.dueAt, v.now),
  ));

  const outcomes: OverdueOutcome[] = [];
  for (const invoice of due) {
    const [client] = await db.select({ name: schema.clients.name })
      .from(schema.clients).where(eq(schema.clients.id, invoice.clientId));
    const amount = `£${(invoice.totalPence / 100).toFixed(2)}`;
    const dueOn = invoice.dueAt.toISOString().slice(0, 10);

    const { ticket } = await createTicket(db, organisationId, {
      clientId: invoice.clientId,
      subject: `Invoice ${invoice.number} is overdue`,
      body: `Invoice ${invoice.number} for ${amount} was due on ${dueOn} and is still unpaid. Chase ${client?.name ?? "the client"} and record the payment once it lands.`,
      severity: "high",
      category: "billing",
      source: "monitor",
      actorKind: "system",
    });

    const [after] = await db.update(schema.invoices)
      .set({
        status: "overdue",
        metadata: { ...invoice.metadata, overdueTicketId: ticket.id },
        updatedAt: new Date(),
      })
      .where(eq(schema.invoices.id, invoice.id))
      .returning();
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "invoice.overdue",
      targetType: "invoice", targetId: invoice.id, before: invoice, after,
    });
    await notifyOwner(db, organisationId, {
      kind: "invoice.overdue",
      title: `Invoice ${invoice.number} is overdue`,
      body: `${client?.name ?? "A client"} owes ${amount}, due ${dueOn}.`,
      link: `/invoices/${invoice.id}`,
    });
    outcomes.push({ invoice: after!, ticketId: ticket.id });
  }
  return outcomes;
}
```

Add to `packages/core/src/index.ts`:
```ts
export { findOverdueInvoices, FindOverdueInvoicesInput } from "./billing/overdue.js";
export type { OverdueOutcome } from "./billing/overdue.js";
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @launchos/core test -- billing`
Expected: PASS (numbering, invoices and overdue — 7 tests).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): invoice numbering, invoice lifecycle and overdue sweep raising billing tickets"
```

---

### Task 6: Core — payments, reconciliation, webhook sync and invoice send approval

**Files:**
- Create: `packages/core/src/billing/payments.ts`, `packages/core/src/billing/webhook-sync.ts`, `packages/core/src/billing/invoice-send.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/events/emit.ts`
- Test: `packages/core/src/billing/payments.test.ts`, `packages/core/src/billing/webhook-sync.test.ts`

**Interfaces:**
- Consumes: `assertOwned`, `recordAudit`, `notifyOwner`, `markInvoicePaid` (Task 5), `EmailAdapter` from `@launchos/channels` (P4), `PaymentsWebhookEvent` from `@launchos/integrations`.
- Produces:
  - `recordPayment(db, organisationId, { clientId, invoiceId?, amountPence, currency?, provider, providerRef?, status?, paidAt?, actorKind?, actorId? })` → the `payments` row
  - `reconcileInvoice(db, organisationId, invoiceId)` → `{ paidPence: number; settled: boolean }`
  - `findOrganisationByStripeCustomer(db, stripeCustomerId): Promise<{ organisationId: string; clientId: string } | undefined>`
  - `syncFromPaymentsEvent(db, organisationId, event: PaymentsWebhookEvent)` → `{ handled: boolean; action: string }`
  - `requestInvoiceSend(db, organisationId, { invoiceId, actorId })` → the pending `approvals` row
  - `sendApprovedInvoice(db, organisationId, { approvalId, actorId }, email: EmailAdapter, portalBaseUrl: string)` → `{ invoiceId: string; to: string }`
  - `DomainEvent` gains `{ name: "payments.webhook"; organisationId: string; providerEvent: PaymentsWebhookEvent }`

- [ ] **Step 1: Write the failing payments test**

`packages/core/src/billing/payments.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { recordPayment, reconcileInvoice } from "./payments.js";

async function invoiced(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `pay-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId: org!.id, clientId: client!.id, number: `LF-2026-${randomUUID().slice(0, 4)}`,
    status: "sent", issuedAt: new Date(), dueAt: new Date(Date.now() + 86_400_000),
    subtotalPence: 10000, vatPence: 2000, totalPence: 12000,
  }).returning();
  return { orgId: org!.id, clientId: client!.id, invoice: invoice! };
}

describe("recordPayment", () => {
  it("settles the invoice when the succeeded payments cover the total", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db);

      await recordPayment(db, orgId, {
        clientId, invoiceId: invoice.id, amountPence: 5000, provider: "bank",
        status: "succeeded", actorKind: "user", actorId: "u1",
      });
      const [partly] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(partly!.status).toBe("sent");

      await recordPayment(db, orgId, {
        clientId, invoiceId: invoice.id, amountPence: 7000, provider: "bank",
        status: "succeeded", actorKind: "user", actorId: "u1",
      });
      const [settled] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(settled!.status).toBe("paid");
      expect(settled!.paidAt).not.toBeNull();
    });
  });

  it("ignores failed payments when reconciling", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db);
      await recordPayment(db, orgId, { clientId, invoiceId: invoice.id, amountPence: 12000, provider: "stripe", status: "failed" });
      const summary = await reconcileInvoice(db, orgId, invoice.id);
      expect(summary).toEqual({ paidPence: 0, settled: false });
    });
  });

  it("records a payment with no invoice attached", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await invoiced(db);
      const payment = await recordPayment(db, orgId, { clientId, amountPence: 2500, provider: "cash", status: "succeeded" });
      expect(payment.invoiceId).toBeNull();
      expect(payment.currency).toBe("GBP");
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/core test -- payments`
Expected: FAIL — `Cannot find module './payments.js'`.

- [ ] **Step 3: Implement payments and reconciliation**

`packages/core/src/billing/payments.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { markInvoicePaid } from "./invoices.js";

export const RecordPaymentInput = z.object({
  clientId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
  amountPence: z.number().int(),
  currency: z.string().length(3).default("GBP"),
  provider: z.enum(["stripe", "bank", "cash", "other"]),
  providerRef: z.string().optional(),
  status: z.enum(["pending", "succeeded", "failed", "refunded"]).default("succeeded"),
  paidAt: z.date().optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type RecordPaymentInput = z.input<typeof RecordPaymentInput>;

export async function recordPayment(db: Db, organisationId: string, input: RecordPaymentInput) {
  const v = RecordPaymentInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  if (v.invoiceId) await assertOwned(db, organisationId, schema.invoices, v.invoiceId);

  const [payment] = await db.insert(schema.payments).values({
    organisationId,
    clientId: v.clientId,
    invoiceId: v.invoiceId ?? null,
    amountPence: v.amountPence,
    currency: v.currency,
    provider: v.provider,
    providerRef: v.providerRef ?? null,
    status: v.status,
    paidAt: v.paidAt ?? (v.status === "succeeded" ? new Date() : null),
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "payment.recorded",
    targetType: "payment", targetId: payment!.id, after: payment,
  });

  if (v.invoiceId) await reconcileInvoice(db, organisationId, v.invoiceId, v.actorId);
  return payment!;
}

/**
 * Sums the succeeded payments against an invoice and marks it paid once they
 * cover the total. Refunds and failures are excluded, so a refunded invoice
 * naturally falls back below its total and is no longer treated as settled.
 */
export async function reconcileInvoice(
  db: Db,
  organisationId: string,
  invoiceId: string,
  actorId?: string,
): Promise<{ paidPence: number; settled: boolean }> {
  await assertOwned(db, organisationId, schema.invoices, invoiceId);
  const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  const rows = await db.select({ amountPence: schema.payments.amountPence }).from(schema.payments).where(and(
    eq(schema.payments.organisationId, organisationId),
    eq(schema.payments.invoiceId, invoiceId),
    eq(schema.payments.status, "succeeded"),
  ));
  const paidPence = rows.reduce((sum, row) => sum + row.amountPence, 0);
  const settled = paidPence >= invoice!.totalPence;
  if (settled && invoice!.status !== "paid" && invoice!.status !== "void") {
    await markInvoicePaid(db, organisationId, { invoiceId, actorKind: "system", actorId });
  }
  return { paidPence, settled };
}
```

- [ ] **Step 4: Write the failing webhook-sync test**

`packages/core/src/billing/webhook-sync.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { findOrganisationByStripeCustomer, syncFromPaymentsEvent } from "./webhook-sync.js";

async function billed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `wh-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  await db.insert(schema.billingProfiles)
    .values({ organisationId: org!.id, clientId: client!.id, billingName: "C Ltd", stripeCustomerId: "cus_live_1" });
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId: org!.id, clientId: client!.id, number: "LF-2026-0001", status: "sent",
    issuedAt: new Date(), dueAt: new Date(Date.now() + 86_400_000),
    subtotalPence: 10000, vatPence: 2000, totalPence: 12000, stripeInvoiceId: "in_live_1",
  }).returning();
  return { orgId: org!.id, clientId: client!.id, invoice: invoice! };
}

describe("findOrganisationByStripeCustomer", () => {
  it("resolves the organisation and client from a customer id", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await billed(db);
      expect(await findOrganisationByStripeCustomer(db, "cus_live_1")).toEqual({ organisationId: orgId, clientId });
      expect(await findOrganisationByStripeCustomer(db, "cus_unknown")).toBeUndefined();
    });
  });
});

describe("syncFromPaymentsEvent", () => {
  it("records a succeeded payment and settles the invoice on invoice.paid", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await billed(db);

      const result = await syncFromPaymentsEvent(db, orgId, {
        id: "evt_1", type: "invoice.paid",
        data: { object: { id: "in_live_1", customer: "cus_live_1", amount_paid: 12000, currency: "gbp" } },
      });

      expect(result).toEqual({ handled: true, action: "invoice.paid" });
      const [after] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(after!.status).toBe("paid");
      const payments = await db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
      expect(payments).toHaveLength(1);
      expect(payments[0]!.provider).toBe("stripe");
      expect(payments[0]!.providerRef).toBe("evt_1");
    });
  });

  it("is idempotent for a repeated event id", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await billed(db);
      const event = {
        id: "evt_1", type: "invoice.paid",
        data: { object: { id: "in_live_1", customer: "cus_live_1", amount_paid: 12000, currency: "gbp" } },
      };
      await syncFromPaymentsEvent(db, orgId, event);
      const repeat = await syncFromPaymentsEvent(db, orgId, event);
      expect(repeat.handled).toBe(false);
      const payments = await db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
      expect(payments).toHaveLength(1);
    });
  });

  it("records a failed payment and notifies the owner on invoice.payment_failed", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await billed(db);

      const result = await syncFromPaymentsEvent(db, orgId, {
        id: "evt_2", type: "invoice.payment_failed",
        data: { object: { id: "in_live_1", customer: "cus_live_1", amount_due: 12000, currency: "gbp" } },
      });

      expect(result.action).toBe("payment.failed");
      const payments = await db.select().from(schema.payments).where(eq(schema.payments.organisationId, orgId));
      expect(payments[0]!.status).toBe("failed");
      const notifications = await db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, orgId));
      expect(notifications.length).toBeGreaterThan(0);
    });
  });

  it("updates the local subscription status on customer.subscription.updated", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await billed(db);
      const [sub] = await db.insert(schema.subscriptions).values({
        organisationId: orgId, clientId, stripeSubscriptionId: "sub_live_1", status: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
        amountPence: 12000,
      }).returning();

      await syncFromPaymentsEvent(db, orgId, {
        id: "evt_3", type: "customer.subscription.updated",
        data: { object: { id: "sub_live_1", customer: "cus_live_1", status: "past_due" } },
      });

      const [after] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, sub!.id));
      expect(after!.status).toBe("past_due");
    });
  });

  it("ignores an event type it does not handle", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await billed(db);
      const result = await syncFromPaymentsEvent(db, orgId, { id: "evt_9", type: "customer.created", data: {} });
      expect(result).toEqual({ handled: false, action: "ignored" });
    });
  });
});
```

- [ ] **Step 5: Run it to verify it fails, then implement the sync**

Run: `pnpm --filter @launchos/core test -- webhook-sync`
Expected: FAIL — `Cannot find module './webhook-sync.js'`.

`packages/core/src/billing/webhook-sync.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsWebhookEvent } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { notifyOwner } from "../notifications/notify.js";
import { recordPayment } from "./payments.js";

const SUBSCRIPTION_STATUS = z.enum(["trialing", "active", "past_due", "cancelled", "paused"]);

const StripeInvoiceObject = z.object({
  id: z.string(),
  customer: z.string(),
  amount_paid: z.number().int().optional(),
  amount_due: z.number().int().optional(),
  currency: z.string().default("gbp"),
});

const StripeSubscriptionObject = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
});

const STRIPE_TO_LOCAL_STATUS: Record<string, z.infer<typeof SUBSCRIPTION_STATUS>> = {
  trialing: "trialing", active: "active", past_due: "past_due", unpaid: "past_due",
  canceled: "cancelled", incomplete_expired: "cancelled", paused: "paused", incomplete: "paused",
};

export interface SyncResult {
  handled: boolean;
  action: string;
}

/**
 * A Stripe webhook arrives with no tenancy of its own. The customer id on the
 * event is the only link back to a LaunchOS organisation, so it is resolved
 * through `billing_profiles.stripe_customer_id` before anything is written.
 */
export async function findOrganisationByStripeCustomer(
  db: Db,
  stripeCustomerId: string,
): Promise<{ organisationId: string; clientId: string } | undefined> {
  const [row] = await db
    .select({ organisationId: schema.billingProfiles.organisationId, clientId: schema.billingProfiles.clientId })
    .from(schema.billingProfiles)
    .where(eq(schema.billingProfiles.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row;
}

export async function syncFromPaymentsEvent(
  db: Db,
  organisationId: string,
  event: PaymentsWebhookEvent,
): Promise<SyncResult> {
  // The provider retries webhooks; the unique (organisation_id, provider,
  // provider_ref) index plus this pre-check make replays a no-op.
  const [seen] = await db.select({ id: schema.payments.id }).from(schema.payments).where(and(
    eq(schema.payments.organisationId, organisationId),
    eq(schema.payments.providerRef, event.id),
  ));
  if (seen) return { handled: false, action: "duplicate" };

  const object = (event.data as { object?: unknown }).object;

  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const parsed = StripeInvoiceObject.safeParse(object);
    if (!parsed.success) return { handled: false, action: "unparseable" };
    const [invoice] = await db.select().from(schema.invoices).where(and(
      eq(schema.invoices.organisationId, organisationId),
      eq(schema.invoices.stripeInvoiceId, parsed.data.id),
    ));
    if (!invoice) return { handled: false, action: "unknown_invoice" };

    const succeeded = event.type === "invoice.paid";
    await recordPayment(db, organisationId, {
      clientId: invoice.clientId,
      invoiceId: invoice.id,
      amountPence: (succeeded ? parsed.data.amount_paid : parsed.data.amount_due) ?? invoice.totalPence,
      currency: parsed.data.currency.toUpperCase(),
      provider: "stripe",
      providerRef: event.id,
      status: succeeded ? "succeeded" : "failed",
      actorKind: "system",
    });

    if (!succeeded) {
      await notifyOwner(db, organisationId, {
        kind: "payment.failed",
        title: `Payment failed for invoice ${invoice.number}`,
        body: `Stripe reported a failed payment of £${(invoice.totalPence / 100).toFixed(2)}.`,
        link: `/invoices/${invoice.id}`,
      });
      return { handled: true, action: "payment.failed" };
    }
    return { handled: true, action: "invoice.paid" };
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const parsed = StripeSubscriptionObject.safeParse(object);
    if (!parsed.success) return { handled: false, action: "unparseable" };
    const status = event.type === "customer.subscription.deleted"
      ? "cancelled"
      : (STRIPE_TO_LOCAL_STATUS[parsed.data.status] ?? "paused");
    const updated = await db.update(schema.subscriptions)
      .set({ status, updatedAt: new Date() })
      .where(and(
        eq(schema.subscriptions.organisationId, organisationId),
        eq(schema.subscriptions.stripeSubscriptionId, parsed.data.id),
      ))
      .returning({ id: schema.subscriptions.id });
    if (updated.length === 0) return { handled: false, action: "unknown_subscription" };
    return { handled: true, action: `subscription.${status}` };
  }

  return { handled: false, action: "ignored" };
}
```

- [ ] **Step 6: Add the domain event and the invoice-send approval**

Extend `packages/core/src/events/emit.ts`'s `DomainEvent` union with:
```ts
  | { name: "payments.webhook"; organisationId: string; providerEvent: PaymentsWebhookEvent }
```
importing `import type { PaymentsWebhookEvent } from "@launchos/integrations";` at the top.

`packages/core/src/billing/invoice-send.ts`:
```ts
import type { EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { markInvoiceSent } from "./invoices.js";

/** Marks an approvals row as an invoice send rather than an agent tool call. */
export const INVOICE_SEND_ACTION = "invoice_send";

export const RequestInvoiceSendInput = z.object({
  invoiceId: z.string().uuid(),
  actorId: z.string().min(1),
});
export type RequestInvoiceSendInput = z.input<typeof RequestInvoiceSendInput>;

/**
 * Emailing a client is outward-facing, so it goes through the same approvals
 * queue an agent tool would use — with no run id, because a human raised it.
 */
export async function requestInvoiceSend(db: Db, organisationId: string, input: RequestInvoiceSendInput) {
  const v = RequestInvoiceSendInput.parse(input);
  await assertOwned(db, organisationId, schema.invoices, v.invoiceId);
  const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, v.invoiceId));
  const [client] = await db.select({ name: schema.clients.name })
    .from(schema.clients).where(eq(schema.clients.id, invoice!.clientId));

  const [approval] = await db.insert(schema.approvals).values({
    organisationId,
    kind: "message_send",
    title: `Send invoice ${invoice!.number} to ${client?.name ?? "the client"}`,
    payload: { action: INVOICE_SEND_ACTION, invoiceId: v.invoiceId, clientId: invoice!.clientId },
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "invoice.send_requested",
    targetType: "invoice", targetId: v.invoiceId, after: approval,
  });
  return approval!;
}

export const SendApprovedInvoiceInput = z.object({
  approvalId: z.string().uuid(),
  actorId: z.string().min(1),
});
export type SendApprovedInvoiceInput = z.input<typeof SendApprovedInvoiceInput>;

export async function sendApprovedInvoice(
  db: Db,
  organisationId: string,
  input: SendApprovedInvoiceInput,
  email: EmailAdapter,
  portalBaseUrl: string,
): Promise<{ invoiceId: string; to: string }> {
  const v = SendApprovedInvoiceInput.parse(input);
  const [approval] = await db.select().from(schema.approvals).where(and(
    eq(schema.approvals.id, v.approvalId),
    eq(schema.approvals.organisationId, organisationId),
    eq(schema.approvals.status, "approved"),
  ));
  if (!approval) throw new Error(`approval ${v.approvalId} is not an approved decision in this organisation`);

  const payload = z.object({ action: z.literal(INVOICE_SEND_ACTION), invoiceId: z.string().uuid() }).parse(approval.payload);
  const [invoice] = await db.select().from(schema.invoices).where(and(
    eq(schema.invoices.id, payload.invoiceId),
    eq(schema.invoices.organisationId, organisationId),
  ));
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, invoice!.clientId));
  const to = client!.email;
  if (!to) throw new Error(`client ${client!.id} has no email address to send invoice ${invoice!.number} to`);

  const link = `${portalBaseUrl}/portal/invoices/${invoice!.id}`;
  const amount = `£${(invoice!.totalPence / 100).toFixed(2)}`;
  await email.send({
    to,
    subject: `Invoice ${invoice!.number} from LaunchFlow`,
    text: `Hello ${client!.name},\n\nInvoice ${invoice!.number} for ${amount} is ready. You can view and print it here:\n${link}\n\nIt is due on ${invoice!.dueAt.toISOString().slice(0, 10)}.\n\nThank you,\nLaunchFlow`,
  });

  await markInvoiceSent(db, organisationId, { invoiceId: invoice!.id, actorKind: "user", actorId: v.actorId });
  await recordActivity(db, organisationId, {
    clientId: invoice!.clientId, actorKind: "user", actorId: v.actorId, kind: "invoice.sent",
    title: `Invoice ${invoice!.number} emailed to ${to}`, link: `/invoices/${invoice!.id}`,
  });
  return { invoiceId: invoice!.id, to };
}
```

Add to `packages/core/src/index.ts`:
```ts
export { recordPayment, reconcileInvoice, RecordPaymentInput } from "./billing/payments.js";
export { findOrganisationByStripeCustomer, syncFromPaymentsEvent } from "./billing/webhook-sync.js";
export type { SyncResult } from "./billing/webhook-sync.js";
export {
  requestInvoiceSend, sendApprovedInvoice, INVOICE_SEND_ACTION,
  RequestInvoiceSendInput, SendApprovedInvoiceInput,
} from "./billing/invoice-send.js";
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @launchos/core test -- billing && pnpm --filter @launchos/core typecheck`
Expected: PASS (all billing suites).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): payments, invoice reconciliation, Stripe webhook sync and invoice-send approval"
```

---

### Task 7: Core — ad accounts, daily ingest, signals and ad reports

**Files:**
- Create: `packages/core/src/ads/accounts.ts`, `packages/core/src/ads/ingest.ts`, `packages/core/src/ads/signals.ts`, `packages/core/src/ads/reports.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/ads/ingest.test.ts`, `packages/core/src/ads/signals.test.ts`

**Interfaces:**
- Consumes: `assertOwned`, `recordAudit`, `recordActivity`, `EmailAdapter` (P4), `AdsAdapter` / `MockAdsAdapter` from `@launchos/integrations`.
- Produces:
  - `createAdAccount(db, organisationId, { clientId, platform, externalId, name, currency?, status?, actorKind?, actorId? })` → the `ad_accounts` row
  - `listAdAccounts(db, organisationId, filter?: { clientId?: string; status?: "active" | "paused" | "disconnected" })` → rows with `clientName`
  - `ingestDailyMetrics(db, organisationId, { date }, ads: AdsAdapter)` → `{ date, accounts, snapshots }`
  - `computeAccountSignals(db, organisationId, adAccountId, { now })` → `AccountSignals`
  - `saveDraftAdReport(db, organisationId, { adAccountId, periodStart, periodEnd, summaryMd, agentRunId? })`, `approveAdReport(db, organisationId, { adReportId, actorId })`, `sendAdReport(db, organisationId, { adReportId, actorId }, email, portalBaseUrl)`
  - `ROAS_DROP_THRESHOLD_PERCENT = 20`, `CPC_RISE_THRESHOLD_PERCENT = 30`, `SIGNAL_WINDOW_DAYS = 7`

- [ ] **Step 1: Write the failing ingest test**

`packages/core/src/ads/ingest.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockAdsAdapter } from "@launchos/integrations";
import { createAdAccount, listAdAccounts } from "./accounts.js";
import { ingestDailyMetrics } from "./ingest.js";

async function orgWithClient(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `ads-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  return { orgId: org!.id, clientId: client!.id };
}

describe("createAdAccount / listAdAccounts", () => {
  it("creates an account and lists it with its client name", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const account = await createAdAccount(db, orgId, {
        clientId, platform: "google", externalId: "123-456-7890", name: "Grays CabLine — Search",
        actorKind: "user", actorId: "u1",
      });
      expect(account.status).toBe("active");
      const listed = await listAdAccounts(db, orgId);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.clientName).toBe("Grays CabLine");
    });
  });
});

describe("ingestDailyMetrics", () => {
  it("writes one snapshot per active account and is idempotent for the same date", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const account = await createAdAccount(db, orgId, { clientId, platform: "google", externalId: "acct-1", name: "Search" });
      const ads = new MockAdsAdapter();

      const first = await ingestDailyMetrics(db, orgId, { date: "2026-09-01" }, ads);
      expect(first).toMatchObject({ date: "2026-09-01", accounts: 1, snapshots: 1 });

      const second = await ingestDailyMetrics(db, orgId, { date: "2026-09-01" }, ads);
      expect(second.snapshots).toBe(1);

      const rows = await db.select().from(schema.adMetricSnapshots)
        .where(eq(schema.adMetricSnapshots.adAccountId, account.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.clicks).toBeGreaterThan(0);
      expect(rows[0]!.roas).toBeGreaterThan(0);
    });
  });

  it("skips paused accounts", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      await createAdAccount(db, orgId, { clientId, platform: "meta", externalId: "act_1", name: "Meta", status: "paused" });
      const result = await ingestDailyMetrics(db, orgId, { date: "2026-09-01" }, new MockAdsAdapter());
      expect(result).toMatchObject({ accounts: 0, snapshots: 0 });
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/core test -- ads`
Expected: FAIL — `Cannot find module './accounts.js'`.

- [ ] **Step 3: Implement accounts and ingest**

`packages/core/src/ads/accounts.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const CreateAdAccountInput = z.object({
  clientId: z.string().uuid(),
  platform: z.enum(["google", "meta"]),
  externalId: z.string().min(1),
  name: z.string().min(1),
  currency: z.string().length(3).default("GBP"),
  status: z.enum(["active", "paused", "disconnected"]).default("active"),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateAdAccountInput = z.input<typeof CreateAdAccountInput>;

export async function createAdAccount(db: Db, organisationId: string, input: CreateAdAccountInput) {
  const v = CreateAdAccountInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  const [account] = await db.insert(schema.adAccounts).values({
    organisationId,
    clientId: v.clientId,
    platform: v.platform,
    externalId: v.externalId,
    name: v.name,
    currency: v.currency,
    status: v.status,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "ad_account.created",
    targetType: "ad_account", targetId: account!.id, after: account,
  });
  await recordActivity(db, organisationId, {
    clientId: v.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "ad_account.created",
    title: `${v.platform === "google" ? "Google" : "Meta"} ads account connected: ${v.name}`,
    link: `/ads/${account!.id}`,
  });
  return account!;
}

export interface AdAccountRow {
  id: string;
  clientId: string;
  clientName: string;
  platform: "google" | "meta";
  externalId: string;
  name: string;
  currency: string;
  status: "active" | "paused" | "disconnected";
}

export async function listAdAccounts(
  db: Db,
  organisationId: string,
  filter: { clientId?: string; status?: "active" | "paused" | "disconnected" } = {},
): Promise<AdAccountRow[]> {
  const where = [
    eq(schema.adAccounts.organisationId, organisationId),
    isNull(schema.adAccounts.deletedAt),
    ...(filter.clientId ? [eq(schema.adAccounts.clientId, filter.clientId)] : []),
    ...(filter.status ? [eq(schema.adAccounts.status, filter.status)] : []),
  ];
  return db.select({
    id: schema.adAccounts.id,
    clientId: schema.adAccounts.clientId,
    clientName: schema.clients.name,
    platform: schema.adAccounts.platform,
    externalId: schema.adAccounts.externalId,
    name: schema.adAccounts.name,
    currency: schema.adAccounts.currency,
    status: schema.adAccounts.status,
  })
    .from(schema.adAccounts)
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(and(...where))
    .orderBy(schema.clients.name, schema.adAccounts.name);
}
```

`packages/core/src/ads/ingest.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { AdsAdapter } from "@launchos/integrations";
import { z } from "zod";
import { listAdAccounts } from "./accounts.js";

export const IngestDailyMetricsInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO calendar date"),
});
export type IngestDailyMetricsInput = z.input<typeof IngestDailyMetricsInput>;

export interface IngestResult {
  date: string;
  accounts: number;
  snapshots: number;
}

/**
 * Pulls one day of metrics for every active ad account.
 *
 * The adapter is injected rather than built from env so `core` never picks an
 * integration (CLAUDE.md rule 4) and tests can pass the deterministic mock.
 * Upserting on (ad_account_id, date) makes a re-run of the cron harmless — a
 * provider that restates yesterday's figures simply overwrites them.
 */
export async function ingestDailyMetrics(
  db: Db,
  organisationId: string,
  input: IngestDailyMetricsInput,
  ads: AdsAdapter,
): Promise<IngestResult> {
  const v = IngestDailyMetricsInput.parse(input);
  const accounts = await listAdAccounts(db, organisationId, { status: "active" });

  let snapshots = 0;
  for (const account of accounts) {
    const metrics = await ads.fetchDailyMetrics(account.externalId, v.date);
    await db.insert(schema.adMetricSnapshots).values({
      organisationId,
      adAccountId: account.id,
      date: v.date,
      spendPence: metrics.spendPence,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      conversions: metrics.conversions,
      conversionValuePence: metrics.conversionValuePence,
      cpcPence: metrics.cpcPence,
      roas: metrics.roas,
    }).onConflictDoUpdate({
      target: [schema.adMetricSnapshots.adAccountId, schema.adMetricSnapshots.date],
      set: {
        spendPence: metrics.spendPence,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        conversions: metrics.conversions,
        conversionValuePence: metrics.conversionValuePence,
        cpcPence: metrics.cpcPence,
        roas: metrics.roas,
        updatedAt: new Date(),
      },
    });
    snapshots += 1;
  }
  // Telemetry, not a business action: snapshots are exempt from audit_log
  // (CLAUDE.md rule 3). The ticket the Sentinel raises from them is audited.
  return { date: v.date, accounts: accounts.length, snapshots };
}
```

- [ ] **Step 4: Write the failing signals test**

`packages/core/src/ads/signals.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { createAdAccount } from "./accounts.js";
import { computeAccountSignals } from "./signals.js";

const NOW = new Date("2026-09-15T07:00:00Z");

/** `offset` days back from 2026-09-15, as an ISO calendar date. */
function dayBefore(offset: number): string {
  return new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
}

async function accountWithSnapshots(db: Db, recentRoas: number, priorRoas: number, recentCpc = 60, priorCpc = 60) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sig-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  const account = await createAdAccount(db, org!.id, { clientId: client!.id, platform: "google", externalId: "acct-1", name: "Search" });

  const rows = [] as (typeof schema.adMetricSnapshots.$inferInsert)[];
  for (let offset = 1; offset <= 14; offset++) {
    const recent = offset <= 7;
    const spendPence = 10_000;
    const cpcPence = recent ? recentCpc : priorCpc;
    const roas = recent ? recentRoas : priorRoas;
    rows.push({
      organisationId: org!.id, adAccountId: account.id, date: dayBefore(offset),
      spendPence, impressions: 5000, clicks: Math.round(spendPence / cpcPence),
      conversions: 10, conversionValuePence: Math.round(spendPence * roas),
      cpcPence, roas,
    });
  }
  await db.insert(schema.adMetricSnapshots).values(rows);
  return { orgId: org!.id, accountId: account.id };
}

describe("computeAccountSignals", () => {
  it("flags a ROAS drop over 20 percent", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await accountWithSnapshots(db, 3, 5);
      const signals = await computeAccountSignals(db, orgId, accountId, { now: NOW });
      expect(signals.current.days).toBe(7);
      expect(signals.previous.days).toBe(7);
      expect(signals.roasDeltaPercent).toBeCloseTo(-40, 1);
      expect(signals.flagged).toBe(true);
      expect(signals.reasons.join(" ")).toMatch(/ROAS/);
    });
  });

  it("flags a CPC rise over 30 percent", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await accountWithSnapshots(db, 5, 5, 100, 60);
      const signals = await computeAccountSignals(db, orgId, accountId, { now: NOW });
      expect(signals.cpcDeltaPercent).toBeGreaterThan(30);
      expect(signals.flagged).toBe(true);
      expect(signals.reasons.join(" ")).toMatch(/CPC/);
    });
  });

  it("does not flag a steady account", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await accountWithSnapshots(db, 5, 5);
      const signals = await computeAccountSignals(db, orgId, accountId, { now: NOW });
      expect(signals.flagged).toBe(false);
      expect(signals.reasons).toEqual([]);
    });
  });

  it("does not flag when there is no prior window to compare against", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sig2-${randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
      const account = await createAdAccount(db, org!.id, { clientId: client!.id, platform: "google", externalId: "a", name: "A" });
      await db.insert(schema.adMetricSnapshots).values({
        organisationId: org!.id, adAccountId: account.id, date: dayBefore(1),
        spendPence: 1000, impressions: 100, clicks: 10, conversions: 1,
        conversionValuePence: 5000, cpcPence: 100, roas: 5,
      });
      const signals = await computeAccountSignals(db, org!.id, account.id, { now: NOW });
      expect(signals.previous.days).toBe(0);
      expect(signals.flagged).toBe(false);
    });
  });
});
```

- [ ] **Step 5: Implement signals and ad reports**

`packages/core/src/ads/signals.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { assertOwned } from "../tenancy/assert-owned.js";

export const SIGNAL_WINDOW_DAYS = 7;
export const ROAS_DROP_THRESHOLD_PERCENT = 20;
export const CPC_RISE_THRESHOLD_PERCENT = 30;

export interface SignalWindow {
  from: string;
  to: string;
  days: number;
  spendPence: number;
  clicks: number;
  conversions: number;
  conversionValuePence: number;
  roas: number;
  cpcPence: number;
}

export interface AccountSignals {
  adAccountId: string;
  name: string;
  platform: "google" | "meta";
  currency: string;
  clientId: string;
  clientName: string;
  current: SignalWindow;
  previous: SignalWindow;
  roasDeltaPercent: number;
  cpcDeltaPercent: number;
  flagged: boolean;
  reasons: string[];
}

function isoDay(now: Date, offsetDays: number): string {
  return new Date(now.getTime() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function summarise(rows: (typeof schema.adMetricSnapshots.$inferSelect)[], from: string, to: string): SignalWindow {
  const spendPence = rows.reduce((s, r) => s + r.spendPence, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const conversions = rows.reduce((s, r) => s + r.conversions, 0);
  const conversionValuePence = rows.reduce((s, r) => s + r.conversionValuePence, 0);
  return {
    from, to, days: rows.length, spendPence, clicks, conversions, conversionValuePence,
    roas: spendPence === 0 ? 0 : conversionValuePence / spendPence,
    cpcPence: clicks === 0 ? 0 : spendPence / clicks,
  };
}

function deltaPercent(current: number, previous: number): number {
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Compares the last 7 days against the 7 before them. Returns the raw windows
 * as well as the verdict so the agent can quote real figures rather than
 * inventing them, and so the admin screen can show the same numbers.
 */
export async function computeAccountSignals(
  db: Db,
  organisationId: string,
  adAccountId: string,
  options: { now: Date },
): Promise<AccountSignals> {
  await assertOwned(db, organisationId, schema.adAccounts, adAccountId);
  const [account] = await db.select({
    id: schema.adAccounts.id,
    name: schema.adAccounts.name,
    platform: schema.adAccounts.platform,
    currency: schema.adAccounts.currency,
    clientId: schema.adAccounts.clientId,
    clientName: schema.clients.name,
  })
    .from(schema.adAccounts)
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(eq(schema.adAccounts.id, adAccountId));

  const currentFrom = isoDay(options.now, SIGNAL_WINDOW_DAYS);
  const previousFrom = isoDay(options.now, SIGNAL_WINDOW_DAYS * 2);
  const today = isoDay(options.now, 0);

  const rows = await db.select().from(schema.adMetricSnapshots).where(and(
    eq(schema.adMetricSnapshots.organisationId, organisationId),
    eq(schema.adMetricSnapshots.adAccountId, adAccountId),
    gte(schema.adMetricSnapshots.date, previousFrom),
    lt(schema.adMetricSnapshots.date, today),
  ));

  const current = summarise(rows.filter((r) => r.date >= currentFrom), currentFrom, today);
  const previous = summarise(rows.filter((r) => r.date < currentFrom), previousFrom, currentFrom);

  const roasDeltaPercent = deltaPercent(current.roas, previous.roas);
  const cpcDeltaPercent = deltaPercent(current.cpcPence, previous.cpcPence);

  const reasons: string[] = [];
  // A missing prior window is not a signal — a new account would otherwise be
  // flagged on its first week.
  if (previous.days > 0) {
    if (roasDeltaPercent <= -ROAS_DROP_THRESHOLD_PERCENT) {
      reasons.push(`ROAS fell ${Math.abs(roasDeltaPercent).toFixed(1)}% (${previous.roas.toFixed(2)} → ${current.roas.toFixed(2)})`);
    }
    if (cpcDeltaPercent >= CPC_RISE_THRESHOLD_PERCENT) {
      reasons.push(`CPC rose ${cpcDeltaPercent.toFixed(1)}% (${(previous.cpcPence / 100).toFixed(2)} → ${(current.cpcPence / 100).toFixed(2)} per click)`);
    }
  }

  return {
    adAccountId,
    name: account!.name,
    platform: account!.platform,
    currency: account!.currency,
    clientId: account!.clientId,
    clientName: account!.clientName,
    current,
    previous,
    roasDeltaPercent,
    cpcDeltaPercent,
    flagged: reasons.length > 0,
    reasons,
  };
}
```

`packages/core/src/ads/reports.ts`:
```ts
import type { EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SaveDraftAdReportInput = z.object({
  adAccountId: z.string().uuid(),
  periodStart: IsoDate,
  periodEnd: IsoDate,
  summaryMd: z.string().min(1),
  agentRunId: z.string().uuid().optional(),
});
export type SaveDraftAdReportInput = z.input<typeof SaveDraftAdReportInput>;

export async function saveDraftAdReport(db: Db, organisationId: string, input: SaveDraftAdReportInput) {
  const v = SaveDraftAdReportInput.parse(input);
  await assertOwned(db, organisationId, schema.adAccounts, v.adAccountId);
  const [report] = await db.insert(schema.adReports).values({
    organisationId,
    adAccountId: v.adAccountId,
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    summaryMd: v.summaryMd,
    status: "draft",
    agentRunId: v.agentRunId ?? null,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.agentRunId ? "agent" : "user", action: "ad_report.drafted",
    targetType: "ad_report", targetId: report!.id, after: report,
  });
  return report!;
}

export const AdReportActionInput = z.object({
  adReportId: z.string().uuid(),
  actorId: z.string().min(1),
});
export type AdReportActionInput = z.input<typeof AdReportActionInput>;

export async function approveAdReport(db: Db, organisationId: string, input: AdReportActionInput) {
  const v = AdReportActionInput.parse(input);
  await assertOwned(db, organisationId, schema.adReports, v.adReportId);
  const [before] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, v.adReportId));
  const [after] = await db.update(schema.adReports)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(schema.adReports.id, v.adReportId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "ad_report.approved",
    targetType: "ad_report", targetId: v.adReportId, before, after,
  });
  return after!;
}

/**
 * A staff member sending an approved report by hand. This is a human action,
 * audited rather than queued — spec §4 reserves the approval gate for the
 * agent's own outward-facing tools.
 */
export async function sendAdReport(
  db: Db,
  organisationId: string,
  input: AdReportActionInput,
  email: EmailAdapter,
  portalBaseUrl: string,
) {
  const v = AdReportActionInput.parse(input);
  await assertOwned(db, organisationId, schema.adReports, v.adReportId);
  const [row] = await db.select({
    report: schema.adReports,
    clientId: schema.adAccounts.clientId,
    clientName: schema.clients.name,
    clientEmail: schema.clients.email,
    accountName: schema.adAccounts.name,
  })
    .from(schema.adReports)
    .innerJoin(schema.adAccounts, eq(schema.adReports.adAccountId, schema.adAccounts.id))
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(and(eq(schema.adReports.id, v.adReportId), eq(schema.adReports.organisationId, organisationId)));
  if (!row!.clientEmail) throw new Error(`client ${row!.clientId} has no email address for the ads report`);

  const link = `${portalBaseUrl}/portal/reports`;
  await email.send({
    to: row!.clientEmail,
    subject: `Your ${row!.accountName} advertising summary`,
    text: `Hello ${row!.clientName},\n\nYour advertising summary for ${row!.report.periodStart} to ${row!.report.periodEnd} is ready in your portal:\n${link}\n\nLaunchFlow`,
  });

  const [after] = await db.update(schema.adReports)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.adReports.id, v.adReportId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "ad_report.sent",
    targetType: "ad_report", targetId: v.adReportId, before: row!.report, after,
  });
  await recordActivity(db, organisationId, {
    clientId: row!.clientId, actorKind: "user", actorId: v.actorId, kind: "ad_report.sent",
    title: `Ads report for ${row!.accountName} sent`, link: `/ads/${row!.report.adAccountId}`,
  });
  return after!;
}
```

Add to `packages/core/src/index.ts`:
```ts
export { createAdAccount, listAdAccounts, CreateAdAccountInput } from "./ads/accounts.js";
export type { AdAccountRow } from "./ads/accounts.js";
export { ingestDailyMetrics, IngestDailyMetricsInput } from "./ads/ingest.js";
export type { IngestResult } from "./ads/ingest.js";
export {
  computeAccountSignals, SIGNAL_WINDOW_DAYS, ROAS_DROP_THRESHOLD_PERCENT, CPC_RISE_THRESHOLD_PERCENT,
} from "./ads/signals.js";
export type { AccountSignals, SignalWindow } from "./ads/signals.js";
export {
  saveDraftAdReport, approveAdReport, sendAdReport, SaveDraftAdReportInput, AdReportActionInput,
} from "./ads/reports.js";
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @launchos/core test -- ads`
Expected: PASS (ingest 3 tests, signals 4 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): ad accounts, daily metric ingest, 7-day signal comparison and ad reports"
```

---

### Task 8: Core — monthly client reports

**Files:**
- Create: `packages/core/src/reports/build-client-report.ts`, `packages/core/src/reports/publish.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/reports/build-client-report.test.ts`

**Interfaces:**
- Consumes: `assertOwned`, `recordAudit`, `recordActivity`, `ClientReportStats` from `@launchos/db/schema`, `schema.tasks` (P3), `schema.tickets`, `schema.uptimeChecks`, `schema.monitors`, `schema.sites`, `schema.invoices`, `schema.adMetricSnapshots`.
- Produces:
  - `buildClientReport(db, organisationId, clientId, period: { start: Date; end: Date })` → the upserted draft `client_reports` row
  - `publishClientReport(db, organisationId, { reportId, actorId })` → the published row
  - `monthPeriod(now: Date)` → `{ start, end }` for the calendar month before `now`

- [ ] **Step 1: Write the failing test**

`packages/core/src/reports/build-client-report.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { buildClientReport, monthPeriod } from "./build-client-report.js";
import { publishClientReport } from "./publish.js";

const PERIOD = { start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z") };

async function busyClient(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `rep-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  const [site] = await db.insert(schema.sites)
    .values({ organisationId: org!.id, clientId: client!.id, name: "S", primaryUrl: "https://s.test" }).returning();
  const [monitor] = await db.insert(schema.monitors)
    .values({ organisationId: org!.id, siteId: site!.id, target: "https://s.test" }).returning();

  await db.insert(schema.uptimeChecks).values([
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-08-05T00:00:00Z"), ok: true },
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-08-06T00:00:00Z"), ok: true },
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-08-07T00:00:00Z"), ok: true },
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-08-08T00:00:00Z"), ok: false },
    // Outside the period — must not count.
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-09-05T00:00:00Z"), ok: false },
  ]);

  await db.insert(schema.tasks).values([
    { organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "social", title: "Post 1", status: "done", completedAt: new Date("2026-08-10T00:00:00Z") },
    { organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "blog", title: "Post 2", status: "done", completedAt: new Date("2026-08-20T00:00:00Z") },
    { organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "seo", title: "Audit", status: "todo" },
  ]);

  await db.insert(schema.tickets).values([
    { organisationId: org!.id, clientId: client!.id, subject: "Opened in August", source: "portal", createdAt: new Date("2026-08-12T00:00:00Z") },
    { organisationId: org!.id, clientId: client!.id, subject: "Resolved in August", source: "portal", status: "resolved", createdAt: new Date("2026-08-13T00:00:00Z"), updatedAt: new Date("2026-08-14T00:00:00Z") },
  ]);

  await db.insert(schema.invoices).values([
    { organisationId: org!.id, clientId: client!.id, number: "LF-2026-0101", status: "paid", issuedAt: new Date("2026-08-01T00:00:00Z"), dueAt: new Date("2026-08-15T00:00:00Z"), subtotalPence: 10000, vatPence: 2000, totalPence: 12000 },
    { organisationId: org!.id, clientId: client!.id, number: "LF-2026-0102", status: "sent", issuedAt: new Date("2026-08-20T00:00:00Z"), dueAt: new Date("2026-09-03T00:00:00Z"), subtotalPence: 5000, vatPence: 1000, totalPence: 6000 },
  ]);

  return { orgId: org!.id, clientId: client!.id };
}

describe("monthPeriod", () => {
  it("returns the calendar month before now", () => {
    const period = monthPeriod(new Date("2026-09-01T05:00:00Z"));
    expect(period.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("buildClientReport", () => {
  it("collects tasks, uptime, tickets, ads and invoices into stats plus Markdown", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await busyClient(db);

      const report = await buildClientReport(db, orgId, clientId, PERIOD);

      expect(report.status).toBe("draft");
      expect(report.periodStart).toBe("2026-08-01");
      expect(report.periodEnd).toBe("2026-08-31");
      expect(report.stats.tasksDone).toBe(2);
      expect(report.stats.tasksOpen).toBe(1);
      expect(report.stats.uptimePercent).toBeCloseTo(75, 1);
      expect(report.stats.ticketsOpened).toBe(2);
      expect(report.stats.ticketsResolved).toBe(1);
      expect(report.stats.ads).toBeNull();
      expect(report.stats.invoices).toEqual({ issued: 2, paidPence: 12000, outstandingPence: 6000 });
      expect(report.summaryMd).toContain("## Work delivered");
      expect(report.summaryMd).toContain("2 tasks completed");
    });
  });

  it("includes an ads section when the client has an ad account with data", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await busyClient(db);
      const [account] = await db.insert(schema.adAccounts)
        .values({ organisationId: orgId, clientId, platform: "google", externalId: "a1", name: "Search" }).returning();
      await db.insert(schema.adMetricSnapshots).values([
        { organisationId: orgId, adAccountId: account!.id, date: "2026-08-10", spendPence: 10000, impressions: 900, clicks: 100, conversions: 5, conversionValuePence: 50000, cpcPence: 100, roas: 5 },
        { organisationId: orgId, adAccountId: account!.id, date: "2026-08-11", spendPence: 10000, impressions: 900, clicks: 100, conversions: 5, conversionValuePence: 30000, cpcPence: 100, roas: 3 },
      ]);

      const report = await buildClientReport(db, orgId, clientId, PERIOD);

      expect(report.stats.ads).toEqual({ spendPence: 20000, clicks: 200, conversions: 10, roas: 4 });
      expect(report.summaryMd).toContain("## Advertising");
    });
  });

  it("rebuilds the same period in place rather than duplicating it", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await busyClient(db);
      const first = await buildClientReport(db, orgId, clientId, PERIOD);
      const second = await buildClientReport(db, orgId, clientId, PERIOD);
      expect(second.id).toBe(first.id);
      const rows = await db.select().from(schema.clientReports).where(eq(schema.clientReports.clientId, clientId));
      expect(rows).toHaveLength(1);
    });
  });

  it("leaves a published report untouched when rebuilt", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await busyClient(db);
      const draft = await buildClientReport(db, orgId, clientId, PERIOD);
      const published = await publishClientReport(db, orgId, { reportId: draft.id, actorId: "u1" });
      expect(published.status).toBe("published");
      expect(published.publishedAt).not.toBeNull();

      const rebuilt = await buildClientReport(db, orgId, clientId, PERIOD);
      expect(rebuilt.status).toBe("published");
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/core test -- build-client-report`
Expected: FAIL — `Cannot find module './build-client-report.js'`.

- [ ] **Step 3: Implement the report builder**

`packages/core/src/reports/build-client-report.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ClientReportStats } from "@launchos/db/schema";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { assertOwned } from "../tenancy/assert-owned.js";

export interface ReportPeriod {
  start: Date;
  end: Date;
}

/** The calendar month that ended before `now`, in UTC. */
export function monthPeriod(now: Date): ReportPeriod {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end };
}

const isoDay = (value: Date) => value.toISOString().slice(0, 10);
const pounds = (pence: number) => `£${(pence / 100).toFixed(2)}`;

/**
 * Assembles one month of a client's work into `client_reports`.
 *
 * Written as a draft the owner reviews before publishing — the client never
 * sees a report LaunchOS generated unread. Rebuilding the same period updates
 * the existing row unless it has already been published, so the monthly cron
 * is safe to re-run.
 */
export async function buildClientReport(
  db: Db,
  organisationId: string,
  clientId: string,
  period: ReportPeriod,
) {
  await assertOwned(db, organisationId, schema.clients, clientId);
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));

  const stats: ClientReportStats = {
    tasksDone: 0, tasksOpen: 0, uptimePercent: null, ticketsOpened: 0, ticketsResolved: 0,
    ads: null, invoices: { issued: 0, paidPence: 0, outstandingPence: 0 },
  };

  const tasks = await db.select({ status: schema.tasks.status, completedAt: schema.tasks.completedAt })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.organisationId, organisationId), eq(schema.tasks.clientId, clientId)));
  for (const task of tasks) {
    const done = task.status === "done" && task.completedAt !== null
      && task.completedAt >= period.start && task.completedAt < period.end;
    if (done) stats.tasksDone += 1;
    else if (task.status !== "done" && task.status !== "cancelled") stats.tasksOpen += 1;
  }

  const checks = await db.select({ ok: schema.uptimeChecks.ok })
    .from(schema.uptimeChecks)
    .innerJoin(schema.monitors, eq(schema.uptimeChecks.monitorId, schema.monitors.id))
    .innerJoin(schema.sites, eq(schema.monitors.siteId, schema.sites.id))
    .where(and(
      eq(schema.uptimeChecks.organisationId, organisationId),
      eq(schema.sites.clientId, clientId),
      gte(schema.uptimeChecks.checkedAt, period.start),
      lt(schema.uptimeChecks.checkedAt, period.end),
    ));
  if (checks.length > 0) {
    stats.uptimePercent = (checks.filter((c) => c.ok).length / checks.length) * 100;
  }

  const tickets = await db.select({
    status: schema.tickets.status, createdAt: schema.tickets.createdAt, updatedAt: schema.tickets.updatedAt,
  })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.organisationId, organisationId), eq(schema.tickets.clientId, clientId)));
  for (const ticket of tickets) {
    if (ticket.createdAt >= period.start && ticket.createdAt < period.end) stats.ticketsOpened += 1;
    const closed = ticket.status === "resolved" || ticket.status === "closed";
    if (closed && ticket.updatedAt >= period.start && ticket.updatedAt < period.end) stats.ticketsResolved += 1;
  }

  const adRows = await db.select({
    spendPence: schema.adMetricSnapshots.spendPence,
    clicks: schema.adMetricSnapshots.clicks,
    conversions: schema.adMetricSnapshots.conversions,
    conversionValuePence: schema.adMetricSnapshots.conversionValuePence,
  })
    .from(schema.adMetricSnapshots)
    .innerJoin(schema.adAccounts, eq(schema.adMetricSnapshots.adAccountId, schema.adAccounts.id))
    .where(and(
      eq(schema.adMetricSnapshots.organisationId, organisationId),
      eq(schema.adAccounts.clientId, clientId),
      gte(schema.adMetricSnapshots.date, isoDay(period.start)),
      lt(schema.adMetricSnapshots.date, isoDay(period.end)),
    ));
  if (adRows.length > 0) {
    const spendPence = adRows.reduce((s, r) => s + r.spendPence, 0);
    const valuePence = adRows.reduce((s, r) => s + r.conversionValuePence, 0);
    stats.ads = {
      spendPence,
      clicks: adRows.reduce((s, r) => s + r.clicks, 0),
      conversions: adRows.reduce((s, r) => s + r.conversions, 0),
      roas: spendPence === 0 ? 0 : valuePence / spendPence,
    };
  }

  const invoices = await db.select({ status: schema.invoices.status, totalPence: schema.invoices.totalPence })
    .from(schema.invoices)
    .where(and(
      eq(schema.invoices.organisationId, organisationId),
      eq(schema.invoices.clientId, clientId),
      gte(schema.invoices.issuedAt, period.start),
      lt(schema.invoices.issuedAt, period.end),
    ));
  stats.invoices = {
    issued: invoices.length,
    paidPence: invoices.filter((i) => i.status === "paid").reduce((s, i) => s + i.totalPence, 0),
    outstandingPence: invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + i.totalPence, 0),
  };

  const summaryMd = renderSummary(client!.name, period, stats);
  const periodStart = isoDay(period.start);
  const periodEnd = isoDay(new Date(period.end.getTime() - 86_400_000));

  const [existing] = await db.select().from(schema.clientReports).where(and(
    eq(schema.clientReports.organisationId, organisationId),
    eq(schema.clientReports.clientId, clientId),
    eq(schema.clientReports.periodStart, periodStart),
  ));
  // A published report is what the client has already read; regenerating it
  // under their feet would rewrite history.
  if (existing?.status === "published") return existing;

  const [row] = existing
    ? await db.update(schema.clientReports)
      .set({ periodEnd, summaryMd, stats, updatedAt: new Date() })
      .where(eq(schema.clientReports.id, existing.id))
      .returning()
    : await db.insert(schema.clientReports)
      .values({ organisationId, clientId, periodStart, periodEnd, summaryMd, stats })
      .returning();
  return row!;
}

function renderSummary(clientName: string, period: ReportPeriod, stats: ClientReportStats): string {
  const month = period.start.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const lines = [
    `# ${clientName} — ${month}`,
    "",
    "## Work delivered",
    `- ${stats.tasksDone} tasks completed this month, ${stats.tasksOpen} still in flight.`,
    "",
    "## Hosting",
    stats.uptimePercent === null
      ? "- No uptime checks recorded for this period."
      : `- Uptime ${stats.uptimePercent.toFixed(2)}% across your monitored sites.`,
    "",
    "## Support",
    `- ${stats.ticketsOpened} requests raised, ${stats.ticketsResolved} resolved.`,
  ];
  if (stats.ads) {
    lines.push(
      "",
      "## Advertising",
      `- Spend ${pounds(stats.ads.spendPence)} for ${stats.ads.clicks} clicks and ${stats.ads.conversions} conversions.`,
      `- Return on ad spend ${stats.ads.roas.toFixed(2)}x.`,
    );
  }
  lines.push(
    "",
    "## Billing",
    `- ${stats.invoices.issued} invoices issued, ${pounds(stats.invoices.paidPence)} paid, ${pounds(stats.invoices.outstandingPence)} outstanding.`,
  );
  return lines.join("\n");
}
```

`packages/core/src/reports/publish.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const PublishClientReportInput = z.object({
  reportId: z.string().uuid(),
  actorId: z.string().min(1),
});
export type PublishClientReportInput = z.input<typeof PublishClientReportInput>;

export async function publishClientReport(db: Db, organisationId: string, input: PublishClientReportInput) {
  const v = PublishClientReportInput.parse(input);
  await assertOwned(db, organisationId, schema.clientReports, v.reportId);
  const [before] = await db.select().from(schema.clientReports).where(eq(schema.clientReports.id, v.reportId));
  const [after] = await db.update(schema.clientReports)
    .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.clientReports.id, v.reportId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "client_report.published",
    targetType: "client_report", targetId: v.reportId, before, after,
  });
  await recordActivity(db, organisationId, {
    clientId: after!.clientId, actorKind: "user", actorId: v.actorId, kind: "client_report.published",
    title: `Report for ${after!.periodStart} published`, link: `/reports/${after!.id}`,
  });
  return after!;
}
```

Add to `packages/core/src/index.ts`:
```ts
export { buildClientReport, monthPeriod } from "./reports/build-client-report.js";
export type { ReportPeriod } from "./reports/build-client-report.js";
export { publishClientReport, PublishClientReportInput } from "./reports/publish.js";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @launchos/core test && pnpm --filter @launchos/core typecheck`
Expected: PASS (whole core suite).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): monthly client report builder and publish"
```

---

### Task 9: Agent — Ad Performance Sentinel with its tools

**Files:**
- Create: `packages/agents/src/tools/ads-list-accounts.ts`, `ads-get-signals.ts`, `ads-save-draft-report.ts`, `reports-send-to-client.ts`
- Create: `packages/agents/src/agents/ad-performance-sentinel/index.ts`
- Modify: `packages/agents/src/tools/tickets-create.ts`, `packages/agents/src/agents/index.ts`, `packages/agents/src/index.ts`, `packages/agents/package.json`
- Test: `packages/agents/src/agents/ad-performance-sentinel/ad-performance-sentinel.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `AgentDefinition`, `runAgent`, `FakeLlmClient`, `text`, `toolUse` (Plan 1 kernel); `listAdAccounts`, `computeAccountSignals`, `saveDraftAdReport`, `createTicket` (Tasks 7 and 5); `EmailAdapter`, `MockEmailAdapter` from `@launchos/channels` (P4).
- Produces:
  - `makeTicketsCreate(agentKey: string): ToolDefinition` and `ticketsCreate = makeTicketsCreate("hosting-guard-dog")`
  - `adsListAccounts`, `adsGetSignals`, `adsSaveDraftReport` (all `risk: "safe"`)
  - `reportsSendToClient(email: EmailAdapter, portalBaseUrl: string): ToolDefinition` (`risk: "requires_approval"`)
  - `adPerformanceSentinel(deps: { email: EmailAdapter; portalBaseUrl: string }): AgentDefinition` with key `ad-performance-sentinel`
  - `agentRegistry(deps: AgentRegistryDeps): Record<string, AgentDefinition>` where `AgentRegistryDeps = { integrations: Integrations; email: EmailAdapter; portalBaseUrl: string }`
  - `AD_SENTINEL_PROMPT`

- [ ] **Step 1: Add the channels dependency to agents**

In `packages/agents/package.json`, add `"@launchos/channels": "workspace:*"` to `dependencies`.

Run: `pnpm install`
Expected: the workspace link resolves.

- [ ] **Step 2: Write the failing agent test**

`packages/agents/src/agents/ad-performance-sentinel/ad-performance-sentinel.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import { createAdAccount } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
import { runAgent } from "../../kernel/run-agent.js";
import { adPerformanceSentinel } from "./index.js";

const NOW = new Date("2026-09-15T07:00:00Z");
const day = (offset: number) => new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);

async function droppingAccount(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sen-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}`, email: "info@grays.test" })
    .returning();
  const account = await createAdAccount(db, org!.id, {
    clientId: client!.id, platform: "google", externalId: "123-456-7890", name: "Grays CabLine — Search",
  });
  const rows: (typeof schema.adMetricSnapshots.$inferInsert)[] = [];
  for (let offset = 1; offset <= 14; offset++) {
    const roas = offset <= 7 ? 2.5 : 5;
    rows.push({
      organisationId: org!.id, adAccountId: account.id, date: day(offset),
      spendPence: 10_000, impressions: 5000, clicks: 160, conversions: 8,
      conversionValuePence: Math.round(10_000 * roas), cpcPence: 62.5, roas,
    });
  }
  await db.insert(schema.adMetricSnapshots).values(rows);
  return { orgId: org!.id, clientId: client!.id, accountId: account.id };
}

describe("ad-performance-sentinel", () => {
  it("reads signals, opens a ticket and drafts a report for a flagged account", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, accountId } = await droppingAccount(db);
      const email = new MockEmailAdapter();
      const agent = adPerformanceSentinel({ email, portalBaseUrl: "http://localhost:3000" });

      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "ads_list_accounts", {})], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("t2", "ads_get_signals", { adAccountId: accountId })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        {
          content: [toolUse("t3", "tickets_create", {
            clientId, subject: "ROAS down 50% on Grays CabLine — Search",
            body: "Last 7 days ROAS 2.50 vs 5.00 in the prior 7.", severity: "high", category: "ads",
          })],
          stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
        },
        {
          content: [toolUse("t4", "ads_save_draft_report", {
            adAccountId: accountId, periodStart: day(7), periodEnd: day(1),
            summaryMd: "## Advertising\nROAS fell from 5.00 to 2.50.",
          })],
          stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
        },
        { content: [text("Flagged one account, opened a ticket and drafted a report.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const result = await runAgent(agent, {
        db, organisationId: orgId, trigger: "cron", payload: { now: NOW.toISOString() },
        llm, policy: "safe", logger: console, now: () => NOW,
      });

      expect(result.status).toBe("completed");

      const tickets = await db.select().from(schema.tickets)
        .where(and(eq(schema.tickets.organisationId, orgId), eq(schema.tickets.category, "ads")));
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.source).toBe("agent");

      const reports = await db.select().from(schema.adReports).where(eq(schema.adReports.adAccountId, accountId));
      expect(reports).toHaveLength(1);
      expect(reports[0]!.status).toBe("draft");
      expect(reports[0]!.agentRunId).toBe(result.runId);

      const signalStep = (await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId)))
        .find((s) => s.kind === "tool_result" && s.toolName === "ads_get_signals");
      expect((signalStep!.output as { flagged: boolean }).flagged).toBe(true);
      expect(email.sent).toHaveLength(0);
    });
  });

  it("parks the run for approval when it tries to send the report to the client", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await droppingAccount(db);
      const email = new MockEmailAdapter();
      const agent = adPerformanceSentinel({ email, portalBaseUrl: "http://localhost:3000" });

      const llm = new FakeLlmClient([
        {
          content: [toolUse("t1", "reports_send_to_client", { adReportId: randomUUID(), adAccountId: accountId })],
          stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]);

      const result = await runAgent(agent, {
        db, organisationId: orgId, trigger: "cron", payload: { now: NOW.toISOString() },
        llm, policy: "safe", logger: console, now: () => NOW,
      });

      expect(result.status).toBe("awaiting_approval");
      const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, result.runId));
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.status).toBe("pending");
      expect(email.sent).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @launchos/agents test -- ad-performance-sentinel`
Expected: FAIL — `Cannot find module './index.js'` under `agents/ad-performance-sentinel`.

- [ ] **Step 4: Make `tickets_create` attributable to any agent**

Replace `packages/agents/src/tools/tickets-create.ts` with:
```ts
import { z } from "zod";
import { createTicket } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

/**
 * `tickets_create` bound to the agent that owns it, so `audit_log.actor_id`
 * names the agent that actually raised the ticket rather than whichever agent
 * happened to define the tool first.
 */
export const makeTicketsCreate = (agentKey: string) =>
  defineTool({
    name: "tickets_create",
    description: "Open an internal support ticket for a client.",
    input: z.object({
      clientId: z.string().uuid(),
      siteId: z.string().uuid().optional(),
      subject: z.string().min(1),
      body: z.string().min(1),
      severity: z.enum(["low", "medium", "high", "critical"]).default("high"),
      category: z.enum(["hosting", "dns", "content", "email", "ads", "billing", "other"]).default("hosting"),
    }),
    risk: "safe",
    execute: async (input, ctx) => {
      const result = await createTicket(ctx.db, ctx.organisationId, {
        ...input,
        source: "agent",
        actorKind: "agent",
        actorId: agentKey,
      });
      return { ticketId: result.ticket.id };
    },
  });

export const ticketsCreate = makeTicketsCreate("hosting-guard-dog");
```

- [ ] **Step 5: Write the four Sentinel tools**

`packages/agents/src/tools/ads-list-accounts.ts`:
```ts
import { z } from "zod";
import { listAdAccounts } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

export const adsListAccounts = defineTool({
  name: "ads_list_accounts",
  description: "List the organisation's active ad accounts with their client, platform and currency.",
  input: z.object({ clientId: z.string().uuid().optional() }),
  risk: "safe",
  execute: async (input, ctx) =>
    listAdAccounts(ctx.db, ctx.organisationId, { clientId: input.clientId, status: "active" }),
});
```

`packages/agents/src/tools/ads-get-signals.ts`:
```ts
import { z } from "zod";
import { computeAccountSignals } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

export const adsGetSignals = defineTool({
  name: "ads_get_signals",
  description:
    "Compare the last 7 days of an ad account against the 7 before them. Returns spend, clicks, conversions, ROAS and CPC for both windows, the percentage deltas, and whether the account is flagged.",
  input: z.object({ adAccountId: z.string().uuid() }),
  risk: "safe",
  execute: async (input, ctx) =>
    computeAccountSignals(ctx.db, ctx.organisationId, input.adAccountId, { now: ctx.now() }),
});
```

`packages/agents/src/tools/ads-save-draft-report.ts`:
```ts
import { z } from "zod";
import { saveDraftAdReport } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

export const adsSaveDraftReport = defineTool({
  name: "ads_save_draft_report",
  description: "Save a client-facing Markdown advertising summary as a draft report. Drafts are never shown to the client until a human approves them.",
  input: z.object({
    adAccountId: z.string().uuid(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    summaryMd: z.string().min(1),
  }),
  risk: "safe",
  execute: async (input, ctx) => {
    const report = await saveDraftAdReport(ctx.db, ctx.organisationId, { ...input, agentRunId: ctx.runId });
    return { adReportId: report.id, status: report.status };
  },
});
```

`packages/agents/src/tools/reports-send-to-client.ts`:
```ts
import { z } from "zod";
import type { EmailAdapter } from "@launchos/channels";
import { sendAdReport } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

/**
 * Outward-facing: emails a client the portal link to an advertising report.
 * `requires_approval`, so the kernel parks the run and a human decides.
 */
export const reportsSendToClient = (email: EmailAdapter, portalBaseUrl: string) =>
  defineTool({
    name: "reports_send_to_client",
    description: "Email the client a link to their advertising report in the portal. Requires human approval before it sends.",
    input: z.object({
      adReportId: z.string().uuid(),
      adAccountId: z.string().uuid(),
    }),
    risk: "requires_approval",
    execute: async (input, ctx) => {
      const report = await sendAdReport(
        ctx.db, ctx.organisationId,
        { adReportId: input.adReportId, actorId: `agent:${ctx.runId}` },
        email, portalBaseUrl,
      );
      return { adReportId: report.id, status: report.status };
    },
  });
```

- [ ] **Step 6: Write the agent definition and register it**

`packages/agents/src/agents/ad-performance-sentinel/index.ts`:
```ts
import type { EmailAdapter } from "@launchos/channels";
import type { AgentDefinition } from "../../kernel/types.js";
import { adsGetSignals } from "../../tools/ads-get-signals.js";
import { adsListAccounts } from "../../tools/ads-list-accounts.js";
import { adsSaveDraftReport } from "../../tools/ads-save-draft-report.js";
import { reportsSendToClient } from "../../tools/reports-send-to-client.js";
import { makeTicketsCreate } from "../../tools/tickets-create.js";

export const AD_SENTINEL_KEY = "ad-performance-sentinel";

export const AD_SENTINEL_PROMPT = `You are the Ad Performance Sentinel for a UK web agency that manages Google and Meta advertising for local-service clients. You run once a day.

Your job, in order:
1. Call ads_list_accounts to get every active ad account.
2. For each account, call ads_get_signals. It compares the last 7 days with the 7 before them and tells you whether the account is flagged (ROAS down more than 20 percent, or CPC up more than 30 percent).
3. For every flagged account, call tickets_create once: category "ads", severity "high" when ROAS fell more than 40 percent otherwise "medium", subject naming the account and the headline change, body a short Markdown diagnosis quoting the exact figures the tool returned.
4. For every flagged account, call ads_save_draft_report once with a client-facing summary: what changed, by how much, the likely reason in plain English, and what you recommend. Use the account's own period dates from the signals.
5. Do not call reports_send_to_client unless the payload explicitly asks you to send a specific report. Sending is a human decision.

Rules: quote only figures the tools returned — never estimate, extrapolate or invent spend, clicks or conversions. If no account is flagged, create nothing and say so. Write client-facing text in plain British English with no jargon and no blame.

Finish with one sentence describing what you did.`;

export interface AdSentinelDeps {
  email: EmailAdapter;
  portalBaseUrl: string;
}

export function adPerformanceSentinel(deps: AdSentinelDeps): AgentDefinition {
  return {
    key: AD_SENTINEL_KEY,
    name: "Ad Performance Sentinel",
    description: "Compares each ad account's last 7 days with the prior 7, opens a ticket for a drop and drafts a client-facing summary.",
    trigger: { kind: "cron", schedule: "0 7 * * *", timezone: "Europe/London" },
    systemPrompt: AD_SENTINEL_PROMPT,
    tools: [
      adsListAccounts,
      adsGetSignals,
      makeTicketsCreate(AD_SENTINEL_KEY),
      adsSaveDraftReport,
      reportsSendToClient(deps.email, deps.portalBaseUrl),
    ],
    maxTurns: 12,
  };
}
```

Replace `packages/agents/src/agents/index.ts` with:
```ts
import type { EmailAdapter } from "@launchos/channels";
import type { Integrations } from "@launchos/integrations";
import type { AgentDefinition } from "../kernel/types.js";
import { adPerformanceSentinel } from "./ad-performance-sentinel/index.js";
import { hostingGuardDog } from "./hosting-guard-dog/index.js";

export interface AgentRegistryDeps {
  integrations: Integrations;
  email: EmailAdapter;
  portalBaseUrl: string;
}

export function agentRegistry(deps: AgentRegistryDeps): Record<string, AgentDefinition> {
  const defs = [
    hostingGuardDog(deps.integrations),
    adPerformanceSentinel({ email: deps.email, portalBaseUrl: deps.portalBaseUrl }),
  ];
  return Object.fromEntries(defs.map((d) => [d.key, d]));
}
```

Plan 4 added a `supportTriage(...)` entry to this array and may already have widened the parameter to an object. Keep its entry — add `supportTriage({ email: deps.email })` (or the exact shape Plan 4 defined) back into `defs` and adjust its call site to read from `deps`. Do not drop it.

Export the new tools and agent from `packages/agents/src/index.ts`:
```ts
export { makeTicketsCreate, ticketsCreate } from "./tools/tickets-create.js";
export { adsListAccounts } from "./tools/ads-list-accounts.js";
export { adsGetSignals } from "./tools/ads-get-signals.js";
export { adsSaveDraftReport } from "./tools/ads-save-draft-report.js";
export { reportsSendToClient } from "./tools/reports-send-to-client.js";
export { adPerformanceSentinel, AD_SENTINEL_KEY, AD_SENTINEL_PROMPT } from "./agents/ad-performance-sentinel/index.js";
```
(the existing `export { ticketsCreate } from "./tools/tickets-create.js";` line is replaced by the first line above).

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @launchos/agents test && pnpm --filter @launchos/agents typecheck`
Expected: PASS — the guard-dog suite still green, plus the two Sentinel tests.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agents): Ad Performance Sentinel with ads tools and an approval-gated report send"
```

---

### Task 10: Worker — Stripe webhook, four crons, and the web webhook route

**Files:**
- Create: `apps/worker/src/jobs/payments-webhook.ts`, `ads-ingest.ts`, `ads-sentinel.ts`, `invoices-overdue.ts`, `reports-monthly.ts`
- Create: `apps/web/src/app/api/webhooks/stripe/route.ts`
- Modify: `apps/worker/src/boss.ts`, `apps/worker/src/env.ts`, `apps/worker/src/index.ts`, `apps/web/src/lib/queue.ts`
- Test: `apps/worker/src/jobs/reports-monthly.test.ts`

**Interfaces:**
- Consumes: `createIntegrations` (Task 3), `createEmailAdapter` (P4), `agentRegistry` (Task 9), `findOverdueInvoices`, `ingestDailyMetrics`, `buildClientReport`, `monthPeriod`, `syncFromPaymentsEvent`, `findOrganisationByStripeCustomer`, `createPaymentsAdapter`.
- Produces:
  - `QUEUE` gains `paymentsWebhook: "payments.webhook"`, `adsIngest: "ads.ingest"`, `adsSentinel: "ads.sentinel"`, `invoicesOverdue: "invoices.check-overdue"`, `reportsMonthly: "reports.monthly"`
  - `handlePaymentsWebhook(db, job: PaymentsWebhookJob)`, `runAdsIngest(db, organisationId, ads, { now })`, `runOverdueSweep(db, organisationId, { now })`, `runMonthlyReports(db, organisationId, { now })`, `enqueueSentinelRuns(db, boss)`
  - `POST /api/webhooks/stripe`

- [ ] **Step 1: Extend the queue names and worker env**

`apps/worker/src/boss.ts` — replace the `QUEUE` const with:
```ts
export const QUEUE = {
  monitorCheck: "monitor.check",
  agentRun: "agent.run",
  agentResume: "agent.resume",
  paymentsWebhook: "payments.webhook",
  adsIngest: "ads.ingest",
  adsSentinel: "ads.sentinel",
  invoicesOverdue: "invoices.check-overdue",
  reportsMonthly: "reports.monthly",
} as const;
```
Plan 4 already added `agentResume`; keep whatever name it used and leave the rest as above. The rest of `createBoss` is unchanged — it already creates every queue in `QUEUE`.

`apps/worker/src/env.ts` — add to the `Env` schema:
```ts
  APP_URL: z.string().url().default("http://localhost:3000"),
  PAYMENTS_ADAPTER: z.enum(["mock", "stripe"]).default("mock"),
  ADS_ADAPTER: z.enum(["mock", "google", "meta"]).default("mock"),
  VAT_RATE: z.coerce.number().min(0).max(100).default(20),
```

- [ ] **Step 2: Write the failing monthly-reports test**

`apps/worker/src/jobs/reports-monthly.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { runMonthlyReports } from "./reports-monthly.js";

describe("runMonthlyReports", () => {
  it("drafts last month's report for every active client and skips archived ones", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `mr-${randomUUID()}` }).returning();
      const [active] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
      await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Gone", slug: `gone-${randomUUID()}`, status: "archived" });

      const result = await runMonthlyReports(db, org!.id, { now: new Date("2026-09-01T05:00:00Z") });

      expect(result).toEqual({ clients: 1, reports: 1, periodStart: "2026-08-01" });
      const rows = await db.select().from(schema.clientReports).where(eq(schema.clientReports.clientId, active!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("draft");
      expect(rows[0]!.periodStart).toBe("2026-08-01");
    });
  });

  it("is safe to run twice for the same month", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `mr2-${randomUUID()}` }).returning();
      await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` });
      const now = new Date("2026-09-01T05:00:00Z");
      await runMonthlyReports(db, org!.id, { now });
      await runMonthlyReports(db, org!.id, { now });
      const rows = await db.select().from(schema.clientReports).where(eq(schema.clientReports.organisationId, org!.id));
      expect(rows).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @launchos/worker test -- reports-monthly`
Expected: FAIL — `Cannot find module './reports-monthly.js'`.

- [ ] **Step 4: Write the five job modules**

`apps/worker/src/jobs/reports-monthly.ts`:
```ts
import { buildClientReport, monthPeriod } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";

export interface MonthlyReportsResult {
  clients: number;
  reports: number;
  periodStart: string;
}

/** Drafts last month's report for every active client. Runs on the 1st. */
export async function runMonthlyReports(
  db: Db,
  organisationId: string,
  options: { now: Date },
): Promise<MonthlyReportsResult> {
  const period = monthPeriod(options.now);
  const clients = await db.select({ id: schema.clients.id }).from(schema.clients).where(and(
    eq(schema.clients.organisationId, organisationId),
    eq(schema.clients.status, "active"),
    isNull(schema.clients.deletedAt),
  ));
  let reports = 0;
  for (const client of clients) {
    await buildClientReport(db, organisationId, client.id, period);
    reports += 1;
  }
  return { clients: clients.length, reports, periodStart: period.start.toISOString().slice(0, 10) };
}
```

`apps/worker/src/jobs/ads-ingest.ts`:
```ts
import { ingestDailyMetrics, type IngestResult } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { AdsAdapter } from "@launchos/integrations";

/** Ingests yesterday's metrics — today's are still accumulating at 06:30. */
export async function runAdsIngest(
  db: Db,
  organisationId: string,
  ads: AdsAdapter,
  options: { now: Date },
): Promise<IngestResult> {
  const date = new Date(options.now.getTime() - 86_400_000).toISOString().slice(0, 10);
  return ingestDailyMetrics(db, organisationId, { date }, ads);
}
```

`apps/worker/src/jobs/invoices-overdue.ts`:
```ts
import { findOverdueInvoices } from "@launchos/core";
import type { Db } from "@launchos/db";

export async function runOverdueSweep(db: Db, organisationId: string, options: { now: Date }) {
  const outcomes = await findOverdueInvoices(db, organisationId, { now: options.now });
  return { flagged: outcomes.length, invoiceNumbers: outcomes.map((o) => o.invoice.number) };
}
```

`apps/worker/src/jobs/payments-webhook.ts`:
```ts
import { syncFromPaymentsEvent, type SyncResult } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { PaymentsWebhookEvent } from "@launchos/integrations";

export interface PaymentsWebhookJob {
  organisationId: string;
  providerEvent: PaymentsWebhookEvent;
}

export async function handlePaymentsWebhook(db: Db, job: PaymentsWebhookJob): Promise<SyncResult> {
  return syncFromPaymentsEvent(db, job.organisationId, job.providerEvent);
}
```

`apps/worker/src/jobs/ads-sentinel.ts`:
```ts
import { AD_SENTINEL_KEY } from "@launchos/agents";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import type { AgentRunJob } from "./agent-run.js";

/**
 * Fans the daily 07:00 cron out into one `agent.run` per organisation that has
 * the Sentinel enabled. A single cron payload cannot carry every organisation,
 * so the schedule wakes this queue and this queue does the fan-out.
 */
export async function buildSentinelJobs(db: Db, now: Date): Promise<AgentRunJob[]> {
  const rows = await db.select({ organisationId: schema.agentEnablement.organisationId })
    .from(schema.agentEnablement)
    .where(and(
      eq(schema.agentEnablement.agentKey, AD_SENTINEL_KEY),
      eq(schema.agentEnablement.enabled, true),
    ));
  return rows.map((row) => ({
    agentKey: AD_SENTINEL_KEY,
    organisationId: row.organisationId,
    trigger: "cron" as const,
    payload: { now: now.toISOString() },
  }));
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @launchos/worker test -- reports-monthly`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire the worker**

In `apps/worker/src/index.ts`, inside `main()`:

Replace the registry and llm construction with:
```ts
  const integrations = createIntegrations(process.env);
  const email = createEmailAdapter(process.env);
  const registry = agentRegistry({ integrations, email, portalBaseUrl: env.APP_URL });
```
adding `import { createEmailAdapter } from "@launchos/channels";` and widening the `setEnqueue` callback with a `payments.webhook` branch:
```ts
    if (event.name === "payments.webhook") {
      const job: PaymentsWebhookJob = { organisationId: event.organisationId, providerEvent: event.providerEvent };
      await boss.send(QUEUE.paymentsWebhook, job, { singletonKey: `stripe:${event.providerEvent.id}` });
    }
```

Add the consumers after the existing `boss.work` calls:
```ts
  await boss.work<PaymentsWebhookJob>(QUEUE.paymentsWebhook, async ([job]) => {
    const result = await handlePaymentsWebhook(db, job!.data);
    console.info({ event: job!.data.providerEvent.type, ...result }, "payments webhook");
  });

  await boss.work(QUEUE.adsIngest, async () => {
    const now = new Date();
    for (const org of await db.select({ id: schema.organisations.id }).from(schema.organisations)) {
      console.info(await runAdsIngest(db, org.id, integrations.ads, { now }), "ads ingest");
    }
  });

  await boss.work(QUEUE.invoicesOverdue, async () => {
    const now = new Date();
    for (const org of await db.select({ id: schema.organisations.id }).from(schema.organisations)) {
      console.info(await runOverdueSweep(db, org.id, { now }), "overdue sweep");
    }
  });

  await boss.work(QUEUE.reportsMonthly, async () => {
    const now = new Date();
    for (const org of await db.select({ id: schema.organisations.id }).from(schema.organisations)) {
      console.info(await runMonthlyReports(db, org.id, { now }), "monthly reports");
    }
  });

  await boss.work(QUEUE.adsSentinel, async () => {
    const jobs = await buildSentinelJobs(db, new Date());
    for (const job of jobs) {
      await boss.send(QUEUE.agentRun, job, {
        singletonKey: `ad-sentinel:${job.organisationId}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
    console.info({ dispatched: jobs.length }, "ad sentinel fan-out");
  });
```

Add the schedules next to the existing `monitor.check` one — all `Europe/London`, which is what Shoji's day runs on:
```ts
  await boss.schedule(QUEUE.adsIngest, "30 6 * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.adsSentinel, "0 7 * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.invoicesOverdue, "30 7 * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.reportsMonthly, "0 5 1 * *", {}, { tz: "Europe/London" });
```

Import the new job modules at the top of the file.

- [ ] **Step 7: Write the Stripe webhook route**

`apps/web/src/app/api/webhooks/stripe/route.ts`:
```ts
import { findOrganisationByStripeCustomer } from "@launchos/core";
import { createPaymentsAdapter } from "@launchos/integrations";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

/**
 * Stripe signs the exact bytes it sent, so the body is read as text and passed
 * to the adapter unparsed. The route only verifies, resolves tenancy and
 * enqueues — every write happens in the worker (ARCHITECTURE.md, job flow).
 */
const CustomerRef = z.object({ object: z.object({ customer: z.string() }).passthrough() });

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing stripe-signature" }, { status: 400 });

  const rawBody = await request.text();
  let providerEvent;
  try {
    providerEvent = createPaymentsAdapter(process.env).webhookVerify(rawBody, signature);
  } catch {
    // Never echo the verification error: it would tell an attacker how close
    // their forgery got.
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const parsed = CustomerRef.safeParse(providerEvent.data);
  if (!parsed.success) return NextResponse.json({ ok: true, ignored: "no customer on event" });

  const owner = await findOrganisationByStripeCustomer(getDb(), parsed.data.object.customer);
  if (!owner) return NextResponse.json({ ok: true, ignored: "unknown customer" });

  await enqueue({ name: "payments.webhook", organisationId: owner.organisationId, providerEvent });
  return NextResponse.json({ ok: true });
}
```

In `apps/web/src/lib/queue.ts`, add a branch to the event-to-queue mapping so the web process sends the job:
```ts
  if (event.name === "payments.webhook") {
    await boss.send("payments.webhook", {
      organisationId: event.organisationId,
      providerEvent: event.providerEvent,
    }, { singletonKey: `stripe:${event.providerEvent.id}` });
    return;
  }
```

Add `"@launchos/integrations": "workspace:*"` to `apps/web/package.json` dependencies, then run `pnpm install`.

- [ ] **Step 8: Smoke the worker locally**

Run: `pnpm db:up && pnpm db:migrate` then, in a second terminal, `pnpm dev:worker` with `LLM=fake` (PowerShell: `$env:LLM="fake"; pnpm dev:worker`).
Expected: `worker started`, no errors, and the pg-boss schedule table contains `ads.ingest`, `ads.sentinel`, `invoices.check-overdue` and `reports.monthly`.

Run: `pnpm --filter @launchos/worker typecheck && pnpm --filter @launchos/web typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(worker): Stripe webhook consumer plus ads ingest, sentinel, overdue and monthly report crons"
```

---

### Task 11: Admin — Payments and Invoices screens

**Files:**
- Create: `apps/web/src/app/(admin)/payments/page.tsx`, `apps/web/src/app/(admin)/payments/actions.ts`
- Create: `apps/web/src/app/(admin)/invoices/page.tsx`, `apps/web/src/app/(admin)/invoices/actions.ts`, `apps/web/src/app/(admin)/invoices/[id]/page.tsx`
- Modify: `apps/web/src/lib/format.ts`, `apps/web/src/components/status-badge.tsx`, `apps/web/src/app/(admin)/layout.tsx`, `apps/web/src/app/(admin)/approvals/actions.ts`

**Interfaces:**
- Consumes: `requireAdmin()`, `getDb()`, `PageHeader`, `EmptyState`, `StatusBadge`, `formatDateTime`; `recordPayment`, `createInvoiceFromSubscription`, `markInvoicePaid`, `voidInvoice`, `requestInvoiceSend`, `sendApprovedInvoice`, `activeSubscriptionForClient`; `createEmailAdapter` (P4).
- Produces: `formatPence(pence: number, currency?: string): string`; routes `/payments`, `/invoices`, `/invoices/[id]`; server actions `recordManualPayment`, `createInvoiceForClient`, `markInvoiceAsPaid`, `voidInvoiceAction`, `requestSendInvoice`.

- [ ] **Step 1: Add the money formatter and the new badge tones**

Append to `apps/web/src/lib/format.ts`:
```ts
/** Pence to a UK currency string. Money is stored as integer pence everywhere. */
export function formatPence(pence: number, currency = "GBP"): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);
}

const DATE_ONLY = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Europe/London" });

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : DATE_ONLY.format(date);
}
```

In `apps/web/src/components/status-badge.tsx`, extend `TONE_BY_VALUE` with the P5 statuses:
```ts
  // invoices
  draft: "neutral",
  sent: "info",
  paid: "success",
  overdue: "danger",
  void: "neutral",
  // subscriptions
  trialing: "info",
  past_due: "danger",
  cancelled: "neutral",
  // payments
  succeeded: "success",
  refunded: "warn",
  // ad accounts and reports
  disconnected: "danger",
```
(`active`, `paused`, `pending`, `approved` and `failed` are already mapped; do not duplicate them.)

- [ ] **Step 2: Turn on the sidebar entries**

In `apps/web/src/app/(admin)/layout.tsx`, give the disabled Plan 2 placeholders their routes and add Reports after Ads, so `NAV` reads (in spec §5 order):

```ts
const NAV: readonly NavItem[] = [
  { label: "Dashboard", href: "/" },
  { label: "Clients", href: "/clients" },
  { label: "Websites", href: "/sites" },
  { label: "Domains", href: "/domains" },
  { label: "Tasks", href: "/tasks" },
  { label: "Inbox", href: "/inbox" },
  { label: "Open Cases", href: "/tickets" },
  { label: "Incidents", href: "/incidents" },
  { label: "Payments", href: "/payments" },
  { label: "Invoices", href: "/invoices" },
  { label: "Ads", href: "/ads" },
  { label: "Reports", href: "/reports" },
  { label: "Approvals", href: "/approvals" },
  { label: "Agents", href: "/agents" },
  { label: "Knowledge Base", href: "/knowledge" },
  { label: "Team", href: "/settings/members" },
  { label: "Settings", href: "/settings/agents" },
];
```
Keep whatever grouping and mobile sheet Plan 2 introduced; only the Payments, Invoices and Ads entries change from disabled to linked, and Reports is new.

- [ ] **Step 3: Payments screen**

`apps/web/src/app/(admin)/payments/actions.ts`:
```ts
"use server";

import { recordPayment } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const ManualPaymentInput = z.object({
  clientId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
  amountPounds: z.coerce.number().positive(),
  provider: z.enum(["stripe", "bank", "cash", "other"]),
  providerRef: z.string().trim().max(200).optional(),
});

export async function recordManualPayment(formData: FormData) {
  const session = await requireAdmin();
  const raw = ManualPaymentInput.parse({
    clientId: formData.get("clientId"),
    invoiceId: formData.get("invoiceId") || undefined,
    amountPounds: formData.get("amountPounds"),
    provider: formData.get("provider"),
    providerRef: formData.get("providerRef") || undefined,
  });

  await recordPayment(getDb(), session.organisationId, {
    clientId: raw.clientId,
    invoiceId: raw.invoiceId,
    // Pounds in the form, pence in the database — rounded once, here.
    amountPence: Math.round(raw.amountPounds * 100),
    provider: raw.provider,
    providerRef: raw.providerRef,
    status: "succeeded",
    actorKind: "user",
    actorId: session.userId,
  });

  revalidatePath("/payments");
  revalidatePath("/invoices");
}
```

`apps/web/src/app/(admin)/payments/page.tsx` — a server component that:
- calls `requireAdmin()`, then selects payments joined to `clients` (name) and left-joined to `invoices` (number) for the session organisation, ordered by `paidAt desc nulls last, createdAt desc`, limit 200;
- renders `<PageHeader title="Payments" description="Every payment recorded against a client, from Stripe or by hand." />`;
- renders a "Record a payment" `<Card>` above the table containing a form with `action={recordManualPayment}`: a `<select name="clientId">` of the organisation's active clients, an optional `<select name="invoiceId">` of unpaid invoices (`status` in `sent`/`overdue`/`draft`, labelled `number — client — total`), `<input name="amountPounds" type="number" step="0.01" min="0.01" required>`, `<select name="provider">` with `bank | cash | stripe | other`, `<input name="providerRef">`, and a submit `<Button>Record payment</Button>`;
- renders the table with columns Date (`formatDateTime(paidAt ?? createdAt)`), Client, Invoice (a `Link` to `/invoices/[id]` when present, otherwise `—`), Amount (`formatPence`), Provider, Reference, Status (`<StatusBadge>`), inside `overflow-x-auto rounded-lg border border-neutral-200 bg-white`;
- shows `<EmptyState>No payments recorded yet. Record one above once money lands.</EmptyState>` when the list is empty;
- sets `export const dynamic = "force-dynamic";`.

- [ ] **Step 4: Invoice actions**

`apps/web/src/app/(admin)/invoices/actions.ts`:
```ts
"use server";

import {
  activeSubscriptionForClient, createInvoiceFromSubscription, markInvoicePaid,
  requestInvoiceSend, voidInvoice, VAT_RATE_DEFAULT_PERCENT,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const ClientRef = z.object({ clientId: z.string().uuid() });
const InvoiceRef = z.object({ invoiceId: z.string().uuid() });

function vatRatePercent(): number {
  const parsed = Number(process.env.VAT_RATE);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : VAT_RATE_DEFAULT_PERCENT;
}

export async function createInvoiceForClient(formData: FormData) {
  const session = await requireAdmin();
  const { clientId } = ClientRef.parse({ clientId: formData.get("clientId") });

  const subscription = await activeSubscriptionForClient(getDb(), session.organisationId, clientId);
  if (!subscription) throw new Error("This client has no active subscription to invoice.");

  const invoice = await createInvoiceFromSubscription(getDb(), session.organisationId, {
    subscriptionId: subscription.id,
    vatRatePercent: vatRatePercent(),
    actorKind: "user",
    actorId: session.userId,
  });

  revalidatePath("/invoices");
  revalidatePath(`/clients/${clientId}/invoices`);
  return invoice.id;
}

export async function markInvoiceAsPaid(formData: FormData) {
  const session = await requireAdmin();
  const { invoiceId } = InvoiceRef.parse({ invoiceId: formData.get("invoiceId") });
  await markInvoicePaid(getDb(), session.organisationId, { invoiceId, actorKind: "user", actorId: session.userId });
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
}

export async function voidInvoiceAction(formData: FormData) {
  const session = await requireAdmin();
  const { invoiceId } = InvoiceRef.parse({ invoiceId: formData.get("invoiceId") });
  await voidInvoice(getDb(), session.organisationId, { invoiceId, actorKind: "user", actorId: session.userId });
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
}

/** Emailing a client is outward-facing, so it queues for approval first. */
export async function requestSendInvoice(formData: FormData) {
  const session = await requireAdmin();
  const { invoiceId } = InvoiceRef.parse({ invoiceId: formData.get("invoiceId") });
  await requestInvoiceSend(getDb(), session.organisationId, { invoiceId, actorId: session.userId });
  revalidatePath("/approvals");
  revalidatePath(`/invoices/${invoiceId}`);
}
```
The approval, not this action, is what actually sends the email — Step 6 wires that. This action only queues the request.

- [ ] **Step 5: Invoice list and detail**

`apps/web/src/app/(admin)/invoices/page.tsx` — server component with a status filter:
- `export const dynamic = "force-dynamic";` and signature `export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">)`; `const { status } = await searchParams;`
- validate with `z.enum(["draft","sent","paid","overdue","void"]).optional().catch(undefined)` so a hand-typed query string cannot break the page;
- select invoices joined to `clients` for the organisation, filtered by status when present, ordered by `issuedAt desc`, limit 200;
- header: `<PageHeader title="Invoices" description="Every invoice raised for a client, and where it has got to." />`;
- a filter row of `<Link href="/invoices">All</Link>` plus one link per status (`/invoices?status=overdue` …), the current one styled `bg-neutral-900 text-white`, the rest `border border-neutral-200 text-neutral-700`;
- table columns: Number (link to `/invoices/[id]`), Client, Status (`StatusBadge`), Issued (`formatDate`), Due (`formatDate`), Total (`formatPence(totalPence, currency)`);
- `<EmptyState>No invoices yet. Raise one from a client's Contacts &amp; Billing tab.</EmptyState>` when empty.

`apps/web/src/app/(admin)/invoices/[id]/page.tsx`:
- `export default async function InvoicePage({ params }: PageProps<"/invoices/[id]">)`; `const { id } = await params;`
- select the invoice scoped by `organisationId` **and** id; `notFound()` when missing;
- also select the client, the linked subscription (if any) and the payments against the invoice;
- header `<PageHeader title={invoice.number} description={client.name} actions={…} />` where actions is a row of forms:
  - `<form action={requestSendInvoice}><input type="hidden" name="invoiceId" value={id} /><Button>Send…</Button></form>`, rendered only when status is `draft`, `sent` or `overdue`;
  - `<form action={markInvoiceAsPaid}>…<Button>Mark paid</Button></form>` unless already `paid` or `void`;
  - `<form action={voidInvoiceAction}>…<Button variant="outline">Void</Button></form>` unless `paid` or `void`;
- a two-column summary `<Card>`: Status badge, Issued, Due, Paid, Currency, Subtotal, VAT, Total, and the Stripe invoice id when set;
- a line-items table from `invoice.lineItems` (Description, Qty, Unit, Line total) and a payments table (Date, Amount, Provider, Reference, Status) with `<EmptyState>No payments recorded against this invoice.</EmptyState>` when there are none;
- a note under the Send button: `Sending emails the client a link to their portal invoice and needs approval first.`

- [ ] **Step 6: Execute an approved invoice send from the approvals screen**

In `apps/web/src/app/(admin)/approvals/actions.ts`, after the existing `recordAudit` call inside `decide(...)` and before `revalidatePath`, dispatch non-agent approvals:
```ts
  if (status === "approved" && (before.payload as { action?: string }).action === INVOICE_SEND_ACTION) {
    await sendApprovedInvoice(
      getDb(),
      session.organisationId,
      { approvalId, actorId: session.userId },
      createEmailAdapter(process.env),
      process.env.APP_URL ?? "http://localhost:3000",
    );
    revalidatePath("/invoices");
  }
```
with `import { INVOICE_SEND_ACTION, sendApprovedInvoice } from "@launchos/core";` and `import { createEmailAdapter } from "@launchos/channels";` at the top. Plan 4's `agent.resume` enqueue for approvals that carry a `runId` stays exactly as it is — an invoice-send approval has no `runId`, so the two branches never both fire.

Add `"@launchos/channels": "workspace:*"` to `apps/web/package.json` if Plan 4 has not already, then `pnpm install`.

- [ ] **Step 7: Verify**

Run: `pnpm --filter @launchos/web typecheck && pnpm --filter @launchos/web build`
Expected: PASS, with `/payments`, `/invoices` and `/invoices/[id]` in the route list.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): Payments and Invoices admin screens with approval-gated invoice send"
```

---

### Task 12: Admin — Ads, Reports, client tabs and Settings → Billing

**Files:**
- Create: `apps/web/src/components/sparkline.tsx`
- Create: `apps/web/src/app/(admin)/ads/page.tsx`, `actions.ts`, `[accountId]/page.tsx`, `reports/page.tsx`
- Create: `apps/web/src/app/(admin)/reports/page.tsx`, `actions.ts`, `[id]/page.tsx`
- Create: `apps/web/src/app/(admin)/settings/billing/page.tsx`
- Create: `apps/web/src/app/(admin)/clients/[id]/billing/subscription-panel.tsx`, `subscription-actions.ts`
- Modify: `apps/web/src/app/(admin)/clients/[id]/invoices/page.tsx`, `apps/web/src/app/(admin)/clients/[id]/reports/page.tsx`, `apps/web/src/app/(admin)/clients/[id]/billing/page.tsx`

**Interfaces:**
- Consumes: `listAdAccounts`, `createAdAccount`, `computeAccountSignals`, `approveAdReport`, `sendAdReport`, `publishClientReport`, `createSubscription`, `cancelSubscription`, `activeSubscriptionForClient`, `createPaymentsAdapter`, `createAdsAdapter`, `vatRateFromEnv`, `createEmailAdapter`.
- Produces: `Sparkline` component; routes `/ads`, `/ads/[accountId]`, `/ads/reports`, `/reports`, `/reports/[id]`, `/settings/billing`; server actions `addAdAccount`, `approveAdReportAction`, `sendAdReportAction`, `publishReportAction`, `startSubscription`, `stopSubscription`.

- [ ] **Step 1: Sparkline component**

`apps/web/src/components/sparkline.tsx`:
```tsx
/**
 * A 30-point trend line. Inline SVG on purpose: no chart library, no client
 * JavaScript, and it renders identically in the printable invoice/report pages.
 */
export function Sparkline({
  values,
  label,
  width = 280,
  height = 48,
}: {
  values: number[];
  label: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <span className="text-xs text-neutral-400">Not enough data</span>;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - ((value - min) / span) * height).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="text-neutral-900"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

- [ ] **Step 2: Ads actions**

`apps/web/src/app/(admin)/ads/actions.ts`:
```ts
"use server";

import { createEmailAdapter } from "@launchos/channels";
import { approveAdReport, createAdAccount, sendAdReport } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const AddAccountInput = z.object({
  clientId: z.string().uuid(),
  platform: z.enum(["google", "meta"]),
  externalId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  currency: z.string().trim().length(3).default("GBP"),
});

export async function addAdAccount(formData: FormData) {
  const session = await requireAdmin();
  const input = AddAccountInput.parse({
    clientId: formData.get("clientId"),
    platform: formData.get("platform"),
    externalId: formData.get("externalId"),
    name: formData.get("name"),
    currency: formData.get("currency") || "GBP",
  });
  await createAdAccount(getDb(), session.organisationId, { ...input, actorKind: "user", actorId: session.userId });
  revalidatePath("/ads");
}

const ReportRef = z.object({ adReportId: z.string().uuid() });

export async function approveAdReportAction(formData: FormData) {
  const session = await requireAdmin();
  const { adReportId } = ReportRef.parse({ adReportId: formData.get("adReportId") });
  await approveAdReport(getDb(), session.organisationId, { adReportId, actorId: session.userId });
  revalidatePath("/ads/reports");
}

export async function sendAdReportAction(formData: FormData) {
  const session = await requireAdmin();
  const { adReportId } = ReportRef.parse({ adReportId: formData.get("adReportId") });
  await sendAdReport(
    getDb(), session.organisationId, { adReportId, actorId: session.userId },
    createEmailAdapter(process.env), process.env.APP_URL ?? "http://localhost:3000",
  );
  revalidatePath("/ads/reports");
}
```

- [ ] **Step 3: Ads screens**

`apps/web/src/app/(admin)/ads/page.tsx`:
- `requireAdmin()`, then `listAdAccounts(getDb(), session.organisationId)`;
- `<PageHeader title="Ads" description="Google and Meta accounts, and how the last week compares with the one before." />`;
- an "Add an ad account" `<Card>` form with `action={addAdAccount}`: client `<select>`, platform `<select>` (`google | meta`), `externalId`, `name`, `currency` (default `GBP`), submit;
- for each account, call `computeAccountSignals(getDb(), session.organisationId, account.id, { now: new Date() })` and render a table: Account (link to `/ads/[accountId]`), Client, Platform, Status badge, 7-day spend (`formatPence(current.spendPence)`), ROAS (`current.roas.toFixed(2)`), ROAS change (`roasDeltaPercent.toFixed(1)}%`, coloured `text-red-600` when negative beyond the threshold), CPC change, and a `<StatusBadge value={signals.flagged ? "flagged" : "steady"} tone={signals.flagged ? "danger" : "success"} />`;
- `<EmptyState>No ad accounts yet. Add one above to start collecting daily metrics.</EmptyState>` when empty.

`apps/web/src/app/(admin)/ads/[accountId]/page.tsx`:
- `const { accountId } = await params;` then select the account scoped by organisation (`notFound()` when missing);
- `computeAccountSignals(...)` for the header cards: two `<Card>`s side by side, "Last 7 days" and "Previous 7 days", each showing spend, clicks, conversions, ROAS and CPC; a third card listing `signals.reasons` or "No signals — this account is steady.";
- select the last 30 snapshots ordered by `date desc`, then `.reverse()` for charting;
- three `<Sparkline>`s labelled "ROAS, last 30 days", "Spend, last 30 days" and "Clicks, last 30 days", fed `snapshots.map(s => s.roas)`, `.spendPence` and `.clicks`;
- a 30-day table (Date, Spend, Impressions, Clicks, Conversions, CPC, ROAS) inside `overflow-x-auto`, newest first;
- a link back to `/ads` and a link to the client at `/clients/[clientId]`.

`apps/web/src/app/(admin)/ads/reports/page.tsx`:
- selects `adReports` joined to `adAccounts` and `clients` for the organisation, ordered by `createdAt desc`;
- table columns: Period (`periodStart` → `periodEnd`), Client, Account, Status badge, Drafted (`formatDateTime(createdAt)`), Agent run (link to `/agents/runs/[agentRunId]` when set), Actions;
- Actions column: `<form action={approveAdReportAction}>` with a hidden `adReportId` and `<Button variant="outline">Approve</Button>` when status is `draft`; `<form action={sendAdReportAction}>` with `<Button>Send</Button>` when status is `approved`; nothing once `sent`;
- a collapsible `<details><summary>Preview</summary>` per row rendering `summaryMd` through `react-markdown`;
- `<EmptyState>No ad reports yet. The Ad Performance Sentinel drafts one when an account is flagged.</EmptyState>`.

- [ ] **Step 4: Client reports screens**

`apps/web/src/app/(admin)/reports/actions.ts`:
```ts
"use server";

import { publishClientReport } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const ReportRef = z.object({ reportId: z.string().uuid() });

export async function publishReportAction(formData: FormData) {
  const session = await requireAdmin();
  const { reportId } = ReportRef.parse({ reportId: formData.get("reportId") });
  const report = await publishClientReport(getDb(), session.organisationId, { reportId, actorId: session.userId });
  revalidatePath("/reports");
  revalidatePath(`/reports/${reportId}`);
  revalidatePath(`/clients/${report.clientId}/reports`);
}
```

`apps/web/src/app/(admin)/reports/page.tsx`: selects `clientReports` joined to `clients` for the organisation, ordered by `periodStart desc`; `<PageHeader title="Reports" description="Monthly client reports. Publish one to make it visible in the client's portal." />`; table columns Period, Client, Status badge, Published (`formatDateTime(publishedAt)`), with the period linking to `/reports/[id]`; `<EmptyState>No reports yet. The monthly job drafts one per active client on the 1st.</EmptyState>`.

`apps/web/src/app/(admin)/reports/[id]/page.tsx`: loads the report scoped by organisation (`notFound()` when missing) plus its client; header with the client name and period, and a `<form action={publishReportAction}>` with `<Button>Publish</Button>` shown only while `status === "draft"`; a stats `<Card>` grid (Tasks done, Tasks open, Uptime, Tickets opened, Tickets resolved, Ad spend, ROAS, Invoices paid) reading `report.stats` with `—` for `null` fields; and the Markdown body rendered with `react-markdown` inside `className="prose prose-neutral max-w-none"`.

- [ ] **Step 5: Client detail tabs and the subscription panel**

`apps/web/src/app/(admin)/clients/[id]/billing/subscription-actions.ts`:
```ts
"use server";

import { cancelSubscription, createSubscription } from "@launchos/core";
import { createPaymentsAdapter } from "@launchos/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const StartInput = z.object({ clientId: z.string().uuid(), packageId: z.string().uuid() });
const StopInput = z.object({ clientId: z.string().uuid(), subscriptionId: z.string().uuid() });

export async function startSubscription(formData: FormData) {
  const session = await requireAdmin();
  const input = StartInput.parse({ clientId: formData.get("clientId"), packageId: formData.get("packageId") });
  await createSubscription(
    getDb(), session.organisationId,
    { ...input, periodStart: new Date(), actorKind: "user", actorId: session.userId },
    createPaymentsAdapter(process.env),
  );
  revalidatePath(`/clients/${input.clientId}/billing`);
}

export async function stopSubscription(formData: FormData) {
  const session = await requireAdmin();
  const input = StopInput.parse({
    clientId: formData.get("clientId"),
    subscriptionId: formData.get("subscriptionId"),
  });
  await cancelSubscription(
    getDb(), session.organisationId,
    { subscriptionId: input.subscriptionId, actorKind: "user", actorId: session.userId },
    createPaymentsAdapter(process.env),
  );
  revalidatePath(`/clients/${input.clientId}/billing`);
}
```

`apps/web/src/app/(admin)/clients/[id]/billing/subscription-panel.tsx` — an async server component `SubscriptionPanel({ organisationId, clientId })` that:
- calls `activeSubscriptionForClient(getDb(), organisationId, clientId)` and selects the organisation's active `packages`;
- when there is a subscription, renders a `<Card>` with the package name, `formatPence(amountPence, currency)` per month, status badge, current period (`formatDate` of start and end), the provider subscription id, and a `<form action={stopSubscription}>` with hidden `clientId`/`subscriptionId` and `<Button variant="outline">Cancel subscription</Button>`;
- when there is none, renders a `<form action={startSubscription}>` with a hidden `clientId`, a `<select name="packageId">` of active packages labelled `name — formatPence(monthlyPricePence)/month`, and `<Button>Start subscription</Button>`; if no packages exist, an `<EmptyState>` pointing at `/settings/packages`.

Import and render `<SubscriptionPanel organisationId={session.organisationId} clientId={id} />` in Plan 2's `apps/web/src/app/(admin)/clients/[id]/billing/page.tsx`, under the existing contacts and billing-profile sections, headed "Subscription".

`apps/web/src/app/(admin)/clients/[id]/invoices/page.tsx` — replace the Plan 2 placeholder body with: invoices for this client (scoped by organisation and `clientId`) ordered by `issuedAt desc`, the same columns as `/invoices` minus Client, a `<form action={createInvoiceForClient}>` with a hidden `clientId` and `<Button>Raise invoice from subscription</Button>` in the header actions, and `<EmptyState>No invoices for this client yet.</EmptyState>`.

`apps/web/src/app/(admin)/clients/[id]/reports/page.tsx` — replace the placeholder with the client's `clientReports` ordered by `periodStart desc`: Period (link to `/reports/[id]`), Status badge, Published, and `<EmptyState>No reports for this client yet.</EmptyState>`.

- [ ] **Step 6: Settings → Billing**

`apps/web/src/app/(admin)/settings/billing/page.tsx` — server component that calls `requireAdmin()` and renders `<PageHeader title="Billing" description="Which payment and ads adapters this deployment is using." />` plus two `<Card>`s:

```tsx
const payments = createPaymentsAdapter(process.env);
const ads = createAdsAdapter(process.env);
const vatRate = vatRateFromEnv(process.env);
```
- **Payments**: adapter name badge (`mock` → tone `warn`, `stripe` → tone `success`), a row per env var showing `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` as "set" or "not set" — **never the value** — and the line `Webhook endpoint: {APP_URL}/api/webhooks/stripe`.
- **Tax**: `VAT rate {vatRate}% (VAT_RATE)`, with the note "Applied to every invoice raised from a subscription."
- **Ads**: adapter name badge and the same set/not-set rows for `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, `META_ADS_ACCESS_TOKEN`, `META_ADS_AD_ACCOUNT_ID`, plus "Mock ingest is deterministic; real Google and Meta ingest needs the credentials above."

Add a link to `/settings/billing` alongside the existing Settings links in the settings navigation Plan 2 built.

- [ ] **Step 7: Verify**

Run: `pnpm --filter @launchos/web typecheck && pnpm --filter @launchos/web build`
Expected: PASS, with `/ads`, `/ads/[accountId]`, `/ads/reports`, `/reports`, `/reports/[id]` and `/settings/billing` in the route list.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): Ads, Reports, client billing tabs and Settings → Billing admin screens"
```

---

### Task 13: Portal invoices and reports, and the P5 seed

**Files:**
- Create: `apps/web/src/app/(portal)/portal/invoices/page.tsx`, `[id]/page.tsx`
- Create: `apps/web/src/app/(portal)/portal/reports/page.tsx`, `[id]/page.tsx`
- Modify: `apps/web/src/app/(portal)/portal/layout.tsx`
- Modify: `packages/db/src/seed.ts`

**Interfaces:**
- Consumes: `requireClient()` (P4) returning `{ userId, organisationId, clientId }`, `formatPence`, `formatDate`, `StatusBadge`, `react-markdown`; `MockPaymentsAdapter`, `MockAdsAdapter` from `@launchos/integrations`.
- Produces: routes `/portal/invoices`, `/portal/invoices/[id]`, `/portal/reports`, `/portal/reports/[id]`; a seed that adds a subscription, two invoices, an ad account with 30 days of snapshots including a last-week ROAS drop, and one published client report.

- [ ] **Step 1: Portal navigation**

In `apps/web/src/app/(portal)/portal/layout.tsx`, add `{ label: "Invoices", href: "/portal/invoices" }` and `{ label: "Reports", href: "/portal/reports" }` to the nav array, after Support and before Account, matching the shape Plan 4 used for the existing entries.

- [ ] **Step 2: Portal invoices**

`apps/web/src/app/(portal)/portal/invoices/page.tsx`:
- `export const dynamic = "force-dynamic";`
- `const session = await requireClient();` — the client id comes from the session, never the URL;
- selects invoices where `organisationId = session.organisationId AND clientId = session.clientId AND status <> 'draft'` ordered by `issuedAt desc`. Drafts are excluded: a draft has not been agreed with the client and must never leak into the portal;
- `<PageHeader title="Invoices" description="Your invoices from LaunchFlow." />`;
- table columns: Number (link to `/portal/invoices/[id]`), Issued, Due, Total, Status badge;
- `<EmptyState>No invoices yet.</EmptyState>` when empty.

`apps/web/src/app/(portal)/portal/invoices/[id]/page.tsx` — the printable invoice:
- `const { id } = await params;` then select the invoice with **all three** of `id`, `organisationId` and `clientId` in the `where`, plus `ne(status, "draft")`; `notFound()` when missing — an id from another client must 404, not 403;
- also select the client and its `billingProfiles` row for the bill-to block;
- renders a plain white document, no navigation chrome inside it:
```tsx
<article className="mx-auto max-w-3xl rounded-lg border border-neutral-200 bg-white p-8 print:border-0 print:p-0">
```
  with a header row: "LaunchFlow" and "Powered by LaunchFlow" on the left, `Invoice {number}` plus issued/due dates and the status badge on the right; a "Billed to" block from the billing profile (`billingName`, `addressLine1`, `addressLine2`, `city`, `postcode`, `country`, and `VAT {vatNumber}` when set), falling back to the client name; the line-items table (Description, Qty, Unit, Amount); a totals block (Subtotal, VAT, Total) right-aligned; and a footer line `Payment terms: {paymentTermsDays} days.`
- above the article, outside the print area, a `<Link href="/portal/invoices" className="print:hidden">Back to invoices</Link>` and the sentence "Use your browser's print dialog to save this invoice as a PDF." in `print:hidden` — the sandboxed page cannot trigger a download itself.

- [ ] **Step 3: Portal reports**

`apps/web/src/app/(portal)/portal/reports/page.tsx`: `requireClient()`, then selects `clientReports` where `organisationId`, `clientId` and `status = 'published'`, ordered by `periodStart desc`; table columns Period (link to `/portal/reports/[id]`) and Published; `<EmptyState>No reports published yet.</EmptyState>`.

`apps/web/src/app/(portal)/portal/reports/[id]/page.tsx`: selects the report by `id`, `organisationId`, `clientId` and `status = 'published'`; `notFound()` otherwise; renders the stat cards (Tasks done, Uptime, Tickets resolved, Ad ROAS where present) and `summaryMd` through `react-markdown` in `className="prose prose-neutral max-w-none"`, with a `print:hidden` back link.

- [ ] **Step 4: Extend the seed**

Add to `packages/db/src/seed.ts`, after the existing client/site/monitor seeding and inside the same `main()` try block:

```ts
import { MockAdsAdapter, MockPaymentsAdapter } from "@launchos/integrations";

const AD_ACCOUNT = { platform: "google" as const, externalId: "123-456-7890", name: "Grays CabLine — Search" };
const SNAPSHOT_DAYS = 30;
const ROAS_DROP_DAYS = 7;

/**
 * Billing, ads and reporting demo data. Idempotent like the rest of the seed:
 * every step looks up by a natural key before inserting.
 */
async function seedBillingAndAds(db: Db, organisationId: string, clients: { id: string; name: string; email: string }[]) {
  const [pkg] = await db.select().from(schema.packages)
    .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.active, true)))
    .orderBy(schema.packages.monthlyPricePence)
    .limit(1);
  if (!pkg) throw new Error("seed: no packages found — the Plan 3 seed step must run before this one");

  const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  for (const client of clients) {
    await ensureBillingProfile(db, organisationId, client);
    const [existing] = await db.select().from(schema.subscriptions).where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      eq(schema.subscriptions.clientId, client.id),
    ));
    const subscription = existing ?? (await createSubscription(
      db, organisationId,
      { clientId: client.id, packageId: pkg.id, periodStart, actorKind: "system" },
      payments,
    )).subscription;

    // Two invoices: last month settled, this month still due.
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const paid = await ensureInvoice(db, organisationId, subscription.id, lastMonth);
    if (paid.status !== "paid") {
      await markInvoiceSent(db, organisationId, { invoiceId: paid.id, actorKind: "system" });
      await recordPayment(db, organisationId, {
        clientId: client.id, invoiceId: paid.id, amountPence: paid.totalPence,
        provider: "bank", providerRef: `seed-${paid.number}`, status: "succeeded", actorKind: "system",
      });
    }
    const due = await ensureInvoice(db, organisationId, subscription.id, periodStart);
    if (due.status === "draft") await markInvoiceSent(db, organisationId, { invoiceId: due.id, actorKind: "system" });
  }

  // One ad account for Grays CabLine with 30 days of deterministic metrics,
  // the last 7 of which show the ROAS slide the Sentinel is meant to catch.
  const grays = clients[0]!;
  const [account] = await db.select().from(schema.adAccounts).where(and(
    eq(schema.adAccounts.organisationId, organisationId),
    eq(schema.adAccounts.externalId, AD_ACCOUNT.externalId),
  ));
  const adAccount = account ?? await createAdAccount(db, organisationId, { clientId: grays.id, ...AD_ACCOUNT });

  const dropFrom = new Date(now.getTime() - ROAS_DROP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const ads = new MockAdsAdapter({ dropFrom });
  for (let offset = SNAPSHOT_DAYS; offset >= 1; offset--) {
    const date = new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    await ingestDailyMetrics(db, organisationId, { date }, ads);
  }

  // One published report for last month so the portal has something to show.
  const period = monthPeriod(now);
  const report = await buildClientReport(db, organisationId, grays.id, period);
  if (report.status === "draft") {
    await publishClientReport(db, organisationId, { reportId: report.id, actorId: "seed" });
  }

  // The Sentinel is enabled so the 07:00 cron has something to dispatch.
  await ensureAgentEnabled(db, organisationId, "ad-performance-sentinel");
}
```

Write the four helpers next to the existing `seedClient` / `seedSite` / `seedMonitor` helpers, in the same look-up-then-insert style:
- `ensureBillingProfile(db, organisationId, client)` — inserts a `billing_profiles` row with `billingName: client.name`, `country: "GB"`, `paymentTermsDays: 14` when none exists for the client;
- `ensureInvoice(db, organisationId, subscriptionId, issuedAt)` — returns the existing invoice for that subscription whose `issuedAt` falls in the same calendar month, otherwise calls `createInvoiceFromSubscription(db, organisationId, { subscriptionId, issuedAt, vatRatePercent: 20, actorKind: "system" })`;
- `ensureAgentEnabled(db, organisationId, agentKey)` — upserts `agent_enablement` with `enabled: true` on the `(organisation_id, agent_key)` unique index (the Plan 1 seed already does this for `hosting-guard-dog`; reuse that helper if it exists rather than writing a second one);
- a `seedClientUser` step, only if Plan 4's seed did not already create one: a Better Auth `user` plus `account` row (the same `hashPassword` path the owner uses) with email from `SEED_CLIENT_EMAIL` (default `portal@grayscabline.co.uk`) and password from `SEED_CLIENT_PASSWORD` (default the same value as `SEED_OWNER_PASSWORD`), and a `client_users` row for Grays CabLine with role `client_admin`.

Call `await seedBillingAndAds(db, organisationId, seededClients)` at the end of `main()`, then extend the seed's closing log line with the counts of subscriptions, invoices, snapshots and reports created.

Add `"@launchos/core": "workspace:*"` and `"@launchos/integrations": "workspace:*"` to `packages/db/package.json` **devDependencies** — the seed is a dev script, so this does not invert the `core → db` dependency direction for the shipped package. Note this in `docs/ARCHITECTURE.md` in Task 14.

- [ ] **Step 5: Run the seed**

Run: `pnpm db:migrate && pnpm db:seed`
Expected: prints the created ids and counts; running it a second time changes nothing (`invoices` still 2 per client, `ad_metric_snapshots` still 30).

- [ ] **Step 6: Verify by hand**

Run: `pnpm dev`, sign in as the owner, and check:
1. `/invoices` lists two invoices per client, one `paid`, one `sent`.
2. `/ads` lists the Grays CabLine account with a negative ROAS change and a `flagged` badge.
3. `/ads/123…` — the detail page shows 30 rows and three sparklines.
4. `/reports` lists a published report for Grays CabLine.
5. Sign out, sign in as the client user, and check `/portal/invoices` (two rows, no drafts), one invoice page prints cleanly, and `/portal/reports` shows the published report.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web,db): portal invoices and reports, and a billing/ads/report seed"
```

---

### Task 14: Playwright smoke, documentation and environment

**Files:**
- Create: `apps/web/tests/e2e/billing-ads-reports.spec.ts`
- Modify: `docs/MODULE_MAP.md`, `docs/DATA_MODEL.md`, `docs/AGENT_FRAMEWORK.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: the seeded owner and client users, `createDb` and `findOverdueInvoices` called directly from the test.
- Produces: one Playwright spec covering the spec §7 P5 acceptance criteria, and refreshed documentation.

- [ ] **Step 1: Write the Playwright spec**

`apps/web/tests/e2e/billing-ads-reports.spec.ts`:
```ts
import { createDb, schema } from "@launchos/db";
import { findOverdueInvoices } from "@launchos/core";
import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";

const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? "shujaat@nexusedu.co.uk";
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "change-me-now";
const CLIENT_EMAIL = process.env.SEED_CLIENT_EMAIL ?? "portal@grayscabline.co.uk";
const CLIENT_PASSWORD = process.env.SEED_CLIENT_PASSWORD ?? OWNER_PASSWORD;

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

test.describe("P5 billing, ads and reporting", () => {
  test("an unpaid invoice pushed past its due date raises a billing ticket in Open Cases", async ({ page }) => {
    const db = createDb(process.env.DATABASE_URL!);

    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto("/invoices?status=sent");
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
    const number = (await page.locator("tbody tr td:first-child").first().innerText()).trim();

    // Age the invoice and run the same core function the 07:30 cron runs.
    const [org] = await db.select({ id: schema.organisations.id }).from(schema.organisations).limit(1);
    await db.update(schema.invoices)
      .set({ dueAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(and(eq(schema.invoices.organisationId, org!.id), eq(schema.invoices.number, number)));
    const outcomes = await findOverdueInvoices(db, org!.id, { now: new Date() });
    expect(outcomes.length).toBeGreaterThan(0);

    await page.goto("/invoices?status=overdue");
    await expect(page.getByRole("cell", { name: number })).toBeVisible();

    await page.goto("/tickets");
    await expect(page.getByText(`Invoice ${number} is overdue`)).toBeVisible();
  });

  test("an ad account shows its 30 days of metrics", async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto("/ads");
    await expect(page.getByRole("heading", { name: "Ads" })).toBeVisible();
    await page.getByRole("link", { name: /Grays CabLine — Search/ }).click();
    await expect(page.getByText("Last 7 days")).toBeVisible();
    await expect(page.getByRole("img", { name: "ROAS, last 30 days" })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(30);
  });

  test("a published report reaches the client portal", async ({ page, context }) => {
    const db = createDb(process.env.DATABASE_URL!);
    const [org] = await db.select({ id: schema.organisations.id }).from(schema.organisations).limit(1);
    const [client] = await db.select({ id: schema.clients.id }).from(schema.clients)
      .where(and(eq(schema.clients.organisationId, org!.id), eq(schema.clients.name, "Grays CabLine")));
    // Start from a draft so the test drives the publish itself.
    const [report] = await db.update(schema.clientReports)
      .set({ status: "draft", publishedAt: null })
      .where(eq(schema.clientReports.clientId, client!.id))
      .returning();

    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto(`/reports/${report!.id}`);
    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByText("published")).toBeVisible();

    await context.clearCookies();
    await signIn(page, CLIENT_EMAIL, CLIENT_PASSWORD);
    await page.goto("/portal/reports");
    await expect(page.getByRole("link", { name: report!.periodStart })).toBeVisible();

    await page.goto("/portal/invoices");
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `pnpm db:seed` then, with `pnpm dev` running, `pnpm --filter @launchos/web exec playwright test billing-ads-reports`
Expected: 3 passed. Re-seed (`pnpm db:seed`) before re-running, since the first test permanently ages an invoice.

- [ ] **Step 3: Environment**

Append to `.env.example`:
```bash
# ---- Payments: mock | stripe (mock is used unless BOTH Stripe keys below are set) ----
PAYMENTS_ADAPTER=mock
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PUBLISHABLE_KEY=
# Days a subscription invoice is due after issue (per-client override lives on billing_profiles)
PAYMENT_TERMS_DAYS=14
# UK standard rate; applied to every invoice raised from a subscription
VAT_RATE=20

# ---- Ads: mock | google | meta (only mock is wired; google/meta need the credentials below) ----
ADS_ADAPTER=mock
# ISO date from which the mock adapter drops ROAS, to exercise the Ad Sentinel locally
MOCK_ADS_DROP_FROM=
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_CUSTOMER_ID=
GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_REFRESH_TOKEN=
META_ADS_ACCESS_TOKEN=
META_ADS_AD_ACCOUNT_ID=
META_ADS_APP_SECRET=

# ---- Seeded client-portal user (dev only) ----
SEED_CLIENT_EMAIL=portal@grayscabline.co.uk
SEED_CLIENT_PASSWORD=
```
The existing `GOOGLE_ADS_DEVELOPER_TOKEN` and `META_ADS_ACCESS_TOKEN` lines in the "Integrations" block are removed so each key appears once.

- [ ] **Step 4: Documentation**

`docs/DATA_MODEL.md` — add a `## billing.ts` section (`subscriptions`, `invoices`, `invoice_sequences`, `payments` with their columns, enums and unique indexes), replace the stub `## ads.ts` section with the columns as actually built (pence integers, `cpc_pence` and `roas` as double precision, `sent_at`), add `## reports.ts` for `client_reports`, and extend the relationship diagram under `clients` with:
```
               │           ├─ subscriptions ── invoices ── payments
               │           ├─ ad_accounts ─┬─ ad_metric_snapshots
               │           │               └─ ad_reports
               │           └─ client_reports
```

`docs/MODULE_MAP.md` — set the Ads row to "yes", and add rows: `/payments` (Payments — payments, clients, invoices / record manual payment), `/invoices`, `/invoices/[id]` (Invoices — invoices, payments, subscriptions / create, mark paid, void, request send), `/ads/reports` (Ad reports — approve, send), `/reports`, `/reports/[id]` (Client reports — publish), `/settings/billing` (Billing settings — adapter status, read-only). In the portal table add `/portal/invoices`, `/portal/invoices/[id]` and `/portal/reports`, `/portal/reports/[id]`, both scoped by `clientId` and filtered to non-draft / published rows. Drop "payments" from the "Later" list.

`docs/AGENT_FRAMEWORK.md` — replace the `ad-performance-sentinel` bullet block with the shipped definition: trigger `cron 0 7 * * *` Europe/London dispatched via the `ads.sentinel` fan-out queue; tools `ads_list_accounts` (safe), `ads_get_signals` (safe), `tickets_create` (safe, bound to the agent key by `makeTicketsCreate`), `ads_save_draft_report` (safe), `reports_send_to_client` (requires_approval); thresholds ROAS −20% and CPC +30% over 7 days versus the prior 7; output one `ads` ticket and one draft `ad_reports` row per flagged account. Add a line to "Adding an agent" noting that agent-attributed tools should be built with a factory taking the agent key.

`docs/ARCHITECTURE.md` — in the queues table add `payments.webhook` (producer: `/api/webhooks/stripe`; payload `{ organisationId, providerEvent }`), `ads.ingest` (cron 06:30), `ads.sentinel` (cron 07:00, fans out to `agent.run`), `invoices.check-overdue` (cron 07:30) and `reports.monthly` (cron 05:00 on the 1st), all `Europe/London`. Add a paragraph under "Integrations" recording that `packages/core` now depends on `packages/integrations` and `packages/channels` for adapter *types*, that adapters are injected as arguments so `core` never reads env, and that `packages/db`'s dev seed depends on `core` and `integrations` as devDependencies only.

`docs/DEPLOYMENT.md` — add a "Stripe" subsection to the Coolify steps: create the webhook endpoint at `https://<domain>/api/webhooks/stripe` subscribed to `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` and `customer.subscription.deleted`; copy the signing secret into `STRIPE_WEBHOOK_SECRET`; set `STRIPE_SECRET_KEY` and `PAYMENTS_ADAPTER=stripe` (with both keys unset the app silently stays on the mock, and Settings → Billing shows which is live). Add an "Ads credentials" subsection stating that Google Ads and Meta remain blocked on external credentials, that `ADS_ADAPTER=mock` is the only wired option, and that the mock ingest is deterministic and safe to leave running. Add the new env var list to the web and worker resource env sections.

`README.md` — update the Status section: Plan 5 implemented; describe subscriptions and invoices with `LF-YYYY-NNNN` numbering, payments and reconciliation, the daily overdue sweep raising billing tickets, ad accounts with deterministic mock ingest, the Ad Performance Sentinel, monthly client reports, and the portal invoice and report pages. Move Stripe keys and Google/Meta ads credentials into the "Blocked on external credentials" list. Add the plan to the Docs list.

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS across every package.

Run: `pnpm --filter @launchos/web build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(web): P5 Playwright smoke; docs(all): data model, module map, agent framework, deployment and env for payments, ads and reporting"
```

---

## Self-review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| §3 P5 `subscriptions`, `invoices`, `payments`, `ad_accounts`, `ad_metric_snapshots`, `ad_reports`, `client_reports` | 1 (migration 0006) |
| §4 Payments — `PaymentsAdapter` with Stripe and mock | 2 |
| §4 Ads — mock ingest, real adapters as interfaces with no fake data | 3, 7 |
| §4 Payments — subscriptions per package, Stripe customer id on the billing profile | 4 |
| §3 `invoices.number` unique per org `LF-2026-0001` | 5 (`nextInvoiceNumber`) |
| §4 "Cron daily: invoices past due → overdue → ticket (category billing) + owner notification" | 5, 10 |
| §4 "Webhook `POST /api/webhooks/stripe` → invoices/payments rows" | 6, 10 |
| §4 "'Send invoice' is an approval that emails the portal link" | 6, 11 |
| §5 design spec — Ad Sentinel: 7 vs prior 7, ROAS −20%, CPC +30%, ticket per account, draft report | 7, 9 |
| §4 "Ad Sentinel per Plan 1 spec; 'Send report' approval emails the portal link" | 9 |
| §7 P5 "monthly client report page" | 8, 12, 13 |
| §5 nav Payments, Invoices, Ads | 11 (`NAV`), 12 |
| §4 client portal `/portal/invoices`, `/portal/reports`; "Invoice HTML page in portal" | 13 |
| §2 seed extension (one invoice minimum — this plan seeds two plus ads and a report) | 13 |
| §7 P5 acceptance — mock subscription, invoice, overdue cron raises a ticket, snapshots ingested, Sentinel flags and drafts, report page renders | 9, 13, 14 |
| §6 env vars `STRIPE_*`, `PAYMENTS_ADAPTER`, `ADS_ADAPTER` (plus `VAT_RATE`, `PAYMENT_TERMS_DAYS`, `MOCK_ADS_DROP_FROM`) | 14 |
| §2 ownership assertions, transactions, domain events, notifications, audit | Global Constraints; every core task |
| Docs `MODULE_MAP`, `DATA_MODEL`, `AGENT_FRAMEWORK`, `ARCHITECTURE`, `DEPLOYMENT`, README | 14 |

**Placeholder scan.** No "TBD", "TODO" or "handle edge cases" steps. Three deliberate cross-plan merge instructions are stated as concrete edits rather than gaps: keeping Plan 4's `supportTriage` entry in `agentRegistry` (Task 9 Step 6), keeping Plan 4's `agentResume` queue name in `QUEUE` (Task 10 Step 1), and reusing Plan 4's seeded client user rather than creating a second one (Task 13 Step 4). `GoogleAdsAdapter` and `MetaAdsAdapter` throw a named error rather than returning invented figures — that is the spec's instruction ("interfaces with no fake data"), not an unfinished step.

**Type consistency, checked and fixed.**
- Money is `…Pence` integers everywhere; only `cpc_pence` and `roas` are `doublePrecision`. `formatPence` is the single presentation helper. The one pounds↔pence conversion lives in `recordManualPayment`.
- `AdDailyMetrics` field names (`spendPence`, `conversionValuePence`, `cpcPence`, `roas`) match the `ad_metric_snapshots` columns one-for-one, so `ingestDailyMetrics` maps them without renaming.
- `PaymentsSubscription.status` is the same five-value union as `subscriptionStatusEnum`, so `createSubscription` assigns it straight through.
- `computeAccountSignals(db, organisationId, adAccountId, { now })` — the id is positional, matching how `adsGetSignals` and both admin ads pages call it.
- `ingestDailyMetrics(db, organisationId, { date }, ads)` — the adapter is a fourth argument in the tool, the worker job, the seed and the tests alike.
- `buildClientReport(db, organisationId, clientId, period)` takes `ReportPeriod { start, end }` as `Date`s and writes `period_start`/`period_end` as ISO date strings; `monthPeriod` is the only producer of that pair.
- `agentRegistry(deps: AgentRegistryDeps)` is object-shaped in Task 9 and called that way in Task 10.
- Tool names use underscores (`ads_list_accounts`, `ads_get_signals`, `ads_save_draft_report`, `reports_send_to_client`, `tickets_create`), matching `tool-registry.ts`'s Claude API constraint.
- Ticket category `billing` and `ads` are already in `ticketCategoryEnum`; approval kind `message_send` is already in `approvalKindEnum`. No enum migration needed for either.

**Two spec ambiguities resolved, recorded here so a reviewer can overrule them.**
1. The spec names the overdue helper `findOverdue`; this plan exports `findOverdueInvoices`, because the function also mutates status and raises tickets and the longer name reads correctly at every call site.
2. Spec §5's nav list has no "Reports" entry, but the plan's scope requires an admin client-reports module. `/reports` is added to the sidebar after Ads; ad reports stay under `/ads/reports` so the two report kinds are never confused.
