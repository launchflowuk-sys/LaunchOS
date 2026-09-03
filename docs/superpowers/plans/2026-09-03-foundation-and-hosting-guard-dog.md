# LaunchOS Plan 1: Foundation + Hosting Guard-Dog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, database, auth, core services, agent kernel and worker, and prove the whole spine with one vertical slice: a monitor detects a site outage, opens an incident, the Hosting Guard-Dog agent diagnoses it and opens a ticket, and Shoji sees it in the admin portal.

**Architecture:** pnpm monorepo. `packages/db` (Drizzle + Postgres) → `packages/core` (domain services, `(db, organisationId, input)`) → `packages/agents` (kernel with typed tools, policy gate, run recorder, LLM client) → `apps/worker` (pg-boss consumers + cron) and `apps/web` (Next.js 16, Better Auth, admin route group). Integrations are mock-first behind interfaces.

**Tech Stack:** Node 24, pnpm 11, TypeScript 5 strict, Next.js 16, React 19, Tailwind 4, shadcn/ui, Drizzle ORM + drizzle-kit, `postgres` driver, Better Auth, pg-boss, Zod 4, `@anthropic-ai/sdk`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-03-agency-os-design.md`

## Global Constraints

- Node `>=24`, pnpm `11.12.0`, TypeScript `strict: true` with `noUncheckedIndexedAccess`.
- PostgreSQL 17 self-hosted only. No Supabase. No Redis.
- Every business table has `organisation_id uuid not null references organisations(id) on delete cascade`.
- Every core service signature is `(db: Db, organisationId: string, input)`.
- Tools declare `risk: "safe" | "requires_approval"`. Outward-facing tools are `requires_approval`.
- Default model `claude-opus-5`, `thinking: { type: "adaptive" }`, `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`.
- No secrets in code. Env validated with Zod at boot.
- Files 800 lines max; functions under 50 lines.
- Commit after every task with a conventional-commit message.

---

## File structure for this plan

```
packages/config/tsconfig.node.json          shared tsconfig for node packages
packages/db/package.json, drizzle.config.ts, tsconfig.json
packages/db/src/schema/_shared.ts           id/timestamps/metadata/organisationId helpers
packages/db/src/schema/system.ts            organisations, organisation_members, client_users
packages/db/src/schema/auth.ts              Better Auth generated tables
packages/db/src/schema/clients.ts           clients, client_contacts
packages/db/src/schema/sites.ts             sites, domains, dns_records
packages/db/src/schema/support.ts           conversations, messages, tickets, ticket_events
packages/db/src/schema/monitoring.ts        monitors, uptime_checks, incidents
packages/db/src/schema/agents.ts            agent_enablement, agent_runs, agent_steps, approvals, audit_log
packages/db/src/schema/index.ts
packages/db/src/client.ts                   createDb(url) → Db
packages/db/src/seed.ts                     dev data
packages/db/src/test/db.ts                  test database helper (per-test transaction rollback)
packages/core/src/audit/record-audit.ts
packages/core/src/clients/create-client.ts
packages/core/src/sites/create-site.ts
packages/core/src/monitoring/create-monitor.ts
packages/core/src/monitoring/record-check.ts        records a check, bumps consecutive_failures, returns whether to open an incident
packages/core/src/incidents/open-incident.ts
packages/core/src/incidents/update-incident.ts
packages/core/src/support/create-ticket.ts          creates conversation + ticket + event
packages/core/src/events/emit.ts                    event → job mapping (pluggable enqueue fn)
packages/agents/src/kernel/types.ts
packages/agents/src/kernel/tool-registry.ts
packages/agents/src/kernel/policy-gate.ts
packages/agents/src/kernel/run-recorder.ts
packages/agents/src/kernel/llm.ts                   LlmClient, AnthropicLlmClient, FakeLlmClient
packages/agents/src/kernel/run-agent.ts
packages/integrations/src/uptime/index.ts           UptimeProbe interface + MockUptimeProbe + HttpUptimeProbe
packages/integrations/src/coolify/index.ts          HostingProvider interface + MockHostingProvider
packages/agents/src/tools/uptime-check-site.ts
packages/agents/src/tools/hosting-get-resources.ts
packages/agents/src/tools/incidents-update.ts
packages/agents/src/tools/tickets-create.ts
packages/agents/src/agents/hosting-guard-dog/index.ts
packages/agents/src/agents/index.ts                 registry
apps/worker/src/env.ts, boss.ts, index.ts
apps/worker/src/jobs/monitor-check.ts
apps/worker/src/jobs/agent-run.ts
apps/web  (Next.js app: auth, session, admin incidents/tickets/agent-runs/approvals pages, health route)
infra/Dockerfile.web, infra/Dockerfile.worker
```

---

### Task 1: Workspace bootstrap and shared config

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.node.json`, `packages/config/vitest.shared.ts`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/src/index.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `packages/agents/package.json`, `packages/agents/tsconfig.json`, `packages/agents/src/index.ts`
- Create: `packages/integrations/package.json`, `packages/integrations/tsconfig.json`, `packages/integrations/src/index.ts`
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/index.ts`

**Interfaces:**
- Produces: workspace package names `@launchos/config`, `@launchos/db`, `@launchos/core`, `@launchos/agents`, `@launchos/integrations`, `@launchos/worker`, `@launchos/web`. Every package has scripts `build`, `typecheck`, `test`, `lint`.

- [ ] **Step 1: Shared config package**

`packages/config/package.json`:
```json
{ "name": "@launchos/config", "version": "0.1.0", "private": true, "files": ["tsconfig.node.json", "vitest.shared.ts"] }
```
`packages/config/tsconfig.node.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "**/*.test.ts"]
}
```
`packages/config/vitest.shared.ts`:
```ts
import { defineConfig } from "vitest/config";
export const sharedVitestConfig = defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 20000, hookTimeout: 30000 },
});
```

- [ ] **Step 2: One package.json template, applied to db/core/agents/integrations**

Use this for `packages/db/package.json` (change `name` for each package; add dependencies as later tasks specify):
```json
{
  "name": "@launchos/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./schema": "./src/schema/index.ts", "./test": "./src/test/db.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "eslint src",
    "generate": "drizzle-kit generate",
    "migrate": "drizzle-kit migrate",
    "studio": "drizzle-kit studio",
    "seed": "tsx src/seed.ts"
  },
  "dependencies": { "drizzle-orm": "^0.45.2", "postgres": "^3.4.9", "zod": "^4.4.3" },
  "devDependencies": { "@launchos/config": "workspace:*", "@types/node": "^24", "drizzle-kit": "^0.31.10", "tsx": "^4", "typescript": "^5", "vitest": "^3" }
}
```
For `core`, `agents`, `integrations`, drop the drizzle scripts and `exports` extras; add `"@launchos/db": "workspace:*"` to `core`; add `"@launchos/core": "workspace:*"`, `"@launchos/integrations": "workspace:*"`, `"@anthropic-ai/sdk": "latest"` to `agents`.

Each `tsconfig.json`:
```json
{ "extends": "@launchos/config/tsconfig.node.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*.ts"] }
```
Each `src/index.ts` starts as `export {};`.

`apps/worker/package.json` adds `"dev": "tsx watch src/index.ts"`, `"start": "node dist/index.js"`, dependencies `@launchos/agents`, `@launchos/core`, `@launchos/db`, `pg-boss: ^10`, `pino: ^9`, `zod`.

- [ ] **Step 3: Install and verify**

Run: `pnpm install && pnpm typecheck`
Expected: all packages typecheck with empty `index.ts` files.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: bootstrap pnpm workspace with db, core, agents, integrations, worker packages"
```

---

### Task 2: Database schema, client, migrations, test helper

**Files:**
- Create: `packages/db/drizzle.config.ts`, `packages/db/src/schema/*.ts` (listed above), `packages/db/src/client.ts`, `packages/db/src/test/db.ts`, `packages/db/src/schema/schema.test.ts`

**Interfaces:**
- Produces: `createDb(url: string): Db`, type `Db`, all table exports from `@launchos/db/schema`, `withTestDb(fn: (db: Db) => Promise<void>)` that runs `fn` inside a transaction and rolls back.

- [ ] **Step 1: Shared column helpers**

`packages/db/src/schema/_shared.ts`:
```ts
import { jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import { organisations } from "./system.js";

export const id = () => uuid("id").defaultRandom().primaryKey();
export const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
export const deletedAt = () => timestamp("deleted_at", { withTimezone: true });
export const metadata = () => jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull();
export const organisationId = () =>
  uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" });
export const baseColumns = () => ({ id: id(), createdAt: createdAt(), updatedAt: updatedAt(), deletedAt: deletedAt(), metadata: metadata() });
export const tenantColumns = () => ({ ...baseColumns(), organisationId: organisationId() });
```

- [ ] **Step 2: Write the failing schema test**

`packages/db/src/schema/schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "../test/db.js";
import { organisations, clients, sites, monitors, incidents, tickets, agentRuns } from "./index.js";

describe("schema", () => {
  it("inserts an organisation → client → site → monitor → incident chain", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "LaunchFlow", slug: "launchflow" }).returning();
      const [client] = await db.insert(clients).values({ organisationId: org!.id, name: "Grays CabLine" }).returning();
      const [site] = await db.insert(sites).values({ organisationId: org!.id, clientId: client!.id, name: "grayscabline.co.uk", primaryUrl: "https://grayscabline.co.uk" }).returning();
      const [monitor] = await db.insert(monitors).values({ organisationId: org!.id, siteId: site!.id, kind: "http", target: "https://grayscabline.co.uk" }).returning();
      const [incident] = await db.insert(incidents).values({ organisationId: org!.id, siteId: site!.id, monitorId: monitor!.id, severity: "high", title: "Site down" }).returning();
      expect(incident!.status).toBe("open");
      const [run] = await db.insert(agentRuns).values({ organisationId: org!.id, agentKey: "hosting-guard-dog", trigger: "event", input: {} }).returning();
      expect(run!.status).toBe("running");
      const [ticket] = await db.insert(tickets).values({ organisationId: org!.id, clientId: client!.id, siteId: site!.id, subject: "Site down", severity: "high", source: "monitor" }).returning();
      expect(ticket!.status).toBe("open");
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @launchos/db test`
Expected: FAIL, modules `./index.js` and `../test/db.js` not found.

- [ ] **Step 4: Schema files**

`packages/db/src/schema/system.ts`:
```ts
import { pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { baseColumns, tenantColumns } from "./_shared.js";
import { user } from "./auth.js";

export const organisationStatusEnum = pgEnum("organisation_status", ["active", "suspended"]);
export const memberRoleEnum = pgEnum("member_role", ["owner", "staff"]);
export const memberStatusEnum = pgEnum("member_status", ["active", "invited", "suspended"]);
export const clientUserRoleEnum = pgEnum("client_user_role", ["client_admin", "client_member"]);

export const organisations = pgTable("organisations", {
  ...baseColumns(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: organisationStatusEnum("status").default("active").notNull(),
});

export const organisationMembers = pgTable("organisation_members", {
  ...tenantColumns(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: memberRoleEnum("role").default("staff").notNull(),
  status: memberStatusEnum("status").default("active").notNull(),
}, (t) => [uniqueIndex("organisation_members_org_user").on(t.organisationId, t.userId)]);

export const clientUsers = pgTable("client_users", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: clientUserRoleEnum("role").default("client_member").notNull(),
}, (t) => [uniqueIndex("client_users_client_user").on(t.clientId, t.userId)]);
```
(`clientId` FK is added in `clients.ts` via a relation to avoid a circular import; enforce with a foreign key in the generated SQL by adding `.references(() => clients.id)` once `clients.ts` exists and import order is `auth → system → clients`.)

`packages/db/src/schema/auth.ts` — Better Auth tables. Generate with `pnpm dlx @better-auth/cli@latest generate --config ../../apps/web/src/lib/auth.ts` in Task 7; until then, create the four tables by hand with the exact columns Better Auth documents for the Drizzle adapter (`user`: `id text pk, name, email unique, email_verified boolean, image, created_at, updated_at`; `session`: `id, expires_at, token unique, created_at, updated_at, ip_address, user_agent, user_id fk`; `account`: `id, account_id, provider_id, user_id fk, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at`; `verification`: `id, identifier, value, expires_at, created_at, updated_at`).

`packages/db/src/schema/clients.ts`:
```ts
import { boolean, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

export const clientStatusEnum = pgEnum("client_status", ["active", "paused", "archived"]);

export const clients = pgTable("clients", {
  ...tenantColumns(),
  name: text("name").notNull(),
  tradingName: text("trading_name"),
  email: text("email"),
  phone: text("phone"),
  status: clientStatusEnum("status").default("active").notNull(),
  notes: text("notes"),
});

export const clientContacts = pgTable("client_contacts", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  role: text("role"),
  isPrimary: boolean("is_primary").default(false).notNull(),
});
```

`packages/db/src/schema/sites.ts`:
```ts
import { boolean, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

export const sitePlatformEnum = pgEnum("site_platform", ["wordpress", "static", "nextjs", "other"]);
export const hostingProviderEnum = pgEnum("hosting_provider", ["coolify", "other"]);
export const siteStatusEnum = pgEnum("site_status", ["live", "building", "paused", "archived"]);
export const domainStatusEnum = pgEnum("domain_status", ["active", "expiring", "expired", "transferring"]);
export const dnsTypeEnum = pgEnum("dns_type", ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]);

export const sites = pgTable("sites", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  primaryUrl: text("primary_url").notNull(),
  platform: sitePlatformEnum("platform").default("wordpress").notNull(),
  hostingProvider: hostingProviderEnum("hosting_provider").default("coolify").notNull(),
  hostingRef: text("hosting_ref"),
  status: siteStatusEnum("status").default("live").notNull(),
});

export const domains = pgTable("domains", {
  ...tenantColumns(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  registrar: text("registrar"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  autoRenew: boolean("auto_renew").default(true).notNull(),
  status: domainStatusEnum("status").default("active").notNull(),
}, (t) => [uniqueIndex("domains_org_name").on(t.organisationId, t.name)]);

export const dnsRecords = pgTable("dns_records", {
  ...tenantColumns(),
  domainId: uuid("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  type: dnsTypeEnum("type").notNull(),
  name: text("name").notNull(),
  value: text("value").notNull(),
  ttl: integer("ttl").default(3600).notNull(),
  proxied: boolean("proxied").default(false).notNull(),
});
```

`packages/db/src/schema/support.ts`:
```ts
import { boolean, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { sites } from "./sites.js";

export const channelEnum = pgEnum("channel", ["portal", "email", "whatsapp", "internal"]);
export const conversationStatusEnum = pgEnum("conversation_status", ["open", "closed"]);
export const messageDirectionEnum = pgEnum("message_direction", ["inbound", "outbound", "internal"]);
export const actorKindEnum = pgEnum("actor_kind", ["user", "client", "agent", "system"]);
export const ticketCategoryEnum = pgEnum("ticket_category", ["hosting", "dns", "content", "email", "ads", "billing", "other"]);
export const severityEnum = pgEnum("severity", ["low", "medium", "high", "critical"]);
export const ticketStatusEnum = pgEnum("ticket_status", ["open", "triaged", "in_progress", "waiting_client", "resolved", "closed"]);
export const ticketSourceEnum = pgEnum("ticket_source", ["portal", "email", "agent", "monitor", "manual"]);
export const ticketEventKindEnum = pgEnum("ticket_event_kind", ["created", "status_changed", "assigned", "note", "escalated", "agent_action"]);

export const conversations = pgTable("conversations", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  subject: text("subject").notNull(),
  channel: channelEnum("channel").default("internal").notNull(),
  status: conversationStatusEnum("status").default("open").notNull(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
});

export const messages = pgTable("messages", {
  ...tenantColumns(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  direction: messageDirectionEnum("direction").notNull(),
  authorKind: actorKindEnum("author_kind").notNull(),
  authorId: text("author_id"),
  body: text("body").notNull(),
  bodyHtml: text("body_html"),
  externalId: text("external_id").unique(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

export const tickets = pgTable("tickets", {
  ...tenantColumns(),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  subject: text("subject").notNull(),
  category: ticketCategoryEnum("category"),
  severity: severityEnum("severity").default("medium").notNull(),
  status: ticketStatusEnum("status").default("open").notNull(),
  assignedUserId: text("assigned_user_id"),
  escalated: boolean("escalated").default(false).notNull(),
  escalationReason: text("escalation_reason"),
  source: ticketSourceEnum("source").default("manual").notNull(),
});

export const ticketEvents = pgTable("ticket_events", {
  ...tenantColumns(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  kind: ticketEventKindEnum("kind").notNull(),
  actorKind: actorKindEnum("actor_kind").notNull(),
  actorId: text("actor_id"),
  data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
});
```

`packages/db/src/schema/monitoring.ts`:
```ts
import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { sites } from "./sites.js";
import { severityEnum, tickets } from "./support.js";

export const monitorKindEnum = pgEnum("monitor_kind", ["http", "ssl", "resource"]);
export const incidentStatusEnum = pgEnum("incident_status", ["open", "acknowledged", "resolved"]);

export const monitors = pgTable("monitors", {
  ...tenantColumns(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  kind: monitorKindEnum("kind").default("http").notNull(),
  target: text("target").notNull(),
  intervalSeconds: integer("interval_seconds").default(60).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
});

export const uptimeChecks = pgTable("uptime_checks", {
  ...tenantColumns(),
  monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
  ok: boolean("ok").notNull(),
  statusCode: integer("status_code"),
  latencyMs: integer("latency_ms"),
  error: text("error"),
}, (t) => [index("uptime_checks_monitor_time").on(t.monitorId, t.checkedAt)]);

export const incidents = pgTable("incidents", {
  ...tenantColumns(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  monitorId: uuid("monitor_id").references(() => monitors.id, { onDelete: "set null" }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  status: incidentStatusEnum("status").default("open").notNull(),
  severity: severityEnum("severity").default("high").notNull(),
  title: text("title").notNull(),
  summaryMd: text("summary_md"),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  agentRunId: uuid("agent_run_id"),
});
```

`packages/db/src/schema/agents.ts`:
```ts
import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { actorKindEnum } from "./support.js";

export const agentTriggerEnum = pgEnum("agent_trigger", ["cron", "event", "manual", "resume"]);
export const agentRunStatusEnum = pgEnum("agent_run_status", ["running", "completed", "awaiting_approval", "failed"]);
export const agentStepKindEnum = pgEnum("agent_step_kind", ["llm", "tool_call", "tool_result", "approval_requested", "note"]);
export const approvalKindEnum = pgEnum("approval_kind", ["tool_call", "report_send", "message_send", "dns_change", "content_change"]);
export const approvalStatusEnum = pgEnum("approval_status", ["pending", "approved", "rejected"]);

export const agentEnablement = pgTable("agent_enablement", {
  ...tenantColumns(),
  agentKey: text("agent_key").notNull(),
  enabled: boolean("enabled").default(false).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
}, (t) => [uniqueIndex("agent_enablement_org_key").on(t.organisationId, t.agentKey)]);

export const agentRuns = pgTable("agent_runs", {
  ...tenantColumns(),
  agentKey: text("agent_key").notNull(),
  trigger: agentTriggerEnum("trigger").notNull(),
  status: agentRunStatusEnum("status").default("running").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().default({}).notNull(),
  summary: text("summary"),
  error: text("error"),
  tokensIn: integer("tokens_in").default(0).notNull(),
  tokensOut: integer("tokens_out").default(0).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const agentSteps = pgTable("agent_steps", {
  ...tenantColumns(),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  kind: agentStepKindEnum("kind").notNull(),
  toolName: text("tool_name"),
  input: jsonb("input").$type<unknown>().default({}).notNull(),
  output: jsonb("output").$type<unknown>().default({}).notNull(),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
}, (t) => [uniqueIndex("agent_steps_run_seq").on(t.runId, t.seq)]);

export const approvals = pgTable("approvals", {
  ...tenantColumns(),
  runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  stepId: uuid("step_id").references(() => agentSteps.id, { onDelete: "set null" }),
  kind: approvalKindEnum("kind").notNull(),
  title: text("title").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  status: approvalStatusEnum("status").default("pending").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
});

export const auditLog = pgTable("audit_log", {
  ...tenantColumns(),
  actorKind: actorKindEnum("actor_kind").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  before: jsonb("before").$type<unknown>(),
  after: jsonb("after").$type<unknown>(),
});
```

`packages/db/src/schema/index.ts` re-exports every file. Order: `auth`, `system`, `clients`, `sites`, `support`, `monitoring`, `agents`.

- [ ] **Step 5: Client and test helper**

`packages/db/src/client.ts`:
```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>;
export function createDb(url: string) {
  const sql = postgres(url, { max: 10, prepare: false });
  return drizzle(sql, { schema, casing: "snake_case" });
}
```
`packages/db/src/index.ts`: `export * from "./client.js"; export * as schema from "./schema/index.js";`

`packages/db/src/test/db.ts`:
```ts
import { createDb, type Db } from "../client.js";

const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL or DATABASE_URL_TEST must be set for tests");
const root = createDb(url);

class Rollback extends Error {}

/** Runs fn inside a transaction that is always rolled back. */
export async function withTestDb(fn: (db: Db) => Promise<void>): Promise<void> {
  try {
    await root.transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}
```

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
const url = process.env.DATABASE_URL;
if (!url && process.argv.some((a) => ["migrate", "studio", "push"].includes(a))) {
  throw new Error("DATABASE_URL must be set for migrate/studio/push");
}
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: { url: url ?? "postgres://launchos:launchos@localhost:5432/launchos" },
});
```

- [ ] **Step 6: Generate and apply the migration, run the test**

Run: `pnpm db:up && pnpm db:generate && pnpm db:migrate && pnpm --filter @launchos/db test`
Expected: one migration file under `packages/db/drizzle/`, test PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): drizzle schema for system, clients, sites, support, monitoring, agents with migration and test helper"
```

---

### Task 3: Core services for the slice

**Files:**
- Create: `packages/core/src/audit/record-audit.ts`, `packages/core/src/clients/create-client.ts`, `packages/core/src/sites/create-site.ts`, `packages/core/src/monitoring/create-monitor.ts`, `packages/core/src/monitoring/record-check.ts`, `packages/core/src/incidents/open-incident.ts`, `packages/core/src/incidents/update-incident.ts`, `packages/core/src/support/create-ticket.ts`, `packages/core/src/events/emit.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/monitoring/record-check.test.ts`, `packages/core/src/support/create-ticket.test.ts`

**Interfaces:**
- Produces:
  - `recordAudit(db, organisationId, { actorKind, actorId?, action, targetType, targetId, before?, after? })`
  - `createClient(db, organisationId, { name, email?, phone? }) → Client`
  - `createSite(db, organisationId, { clientId, name, primaryUrl }) → Site`
  - `createMonitor(db, organisationId, { siteId, target, intervalSeconds? }) → Monitor`
  - `recordCheck(db, organisationId, { monitorId, ok, statusCode?, latencyMs?, error? }) → { check, consecutiveFailures, shouldOpenIncident, shouldResolveIncident }`
  - `openIncident(db, organisationId, { siteId, monitorId?, title, severity? }) → Incident`
  - `updateIncident(db, organisationId, { incidentId, status?, summaryMd?, ticketId?, agentRunId? }) → Incident`
  - `createTicket(db, organisationId, { clientId, siteId?, subject, body, severity?, source, category? }) → { ticket, conversation }`
  - `emit(event: DomainEvent)` with `setEnqueue(fn)`; `DomainEvent = { name: "incident.opened", organisationId, incidentId } | { name: "ticket.created", organisationId, ticketId }`

- [ ] **Step 1: Failing test for recordCheck**

`packages/core/src/monitoring/record-check.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { createSite } from "../sites/create-site.js";
import { createMonitor } from "./create-monitor.js";
import { recordCheck } from "./record-check.js";

describe("recordCheck", () => {
  it("opens an incident on the 3rd consecutive failure and resolves on recovery", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: "t" }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const site = await createSite(db, org!.id, { clientId: client.id, name: "S", primaryUrl: "https://s.test" });
      const monitor = await createMonitor(db, org!.id, { siteId: site.id, target: "https://s.test" });

      const r1 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: false, error: "timeout" });
      const r2 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: false, error: "timeout" });
      const r3 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: false, error: "timeout" });
      expect([r1.shouldOpenIncident, r2.shouldOpenIncident, r3.shouldOpenIncident]).toEqual([false, false, true]);
      expect(r3.consecutiveFailures).toBe(3);

      const r4 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: false, error: "timeout" });
      expect(r4.shouldOpenIncident).toBe(false); // only fires once at the threshold

      const r5 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: true, statusCode: 200, latencyMs: 120 });
      expect(r5.consecutiveFailures).toBe(0);
      expect(r5.shouldResolveIncident).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement audit, clients, sites, monitors**

`packages/core/src/audit/record-audit.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";

export const RecordAuditInput = z.object({
  actorKind: z.enum(["user", "client", "agent", "system"]),
  actorId: z.string().optional(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type RecordAuditInput = z.infer<typeof RecordAuditInput>;

export async function recordAudit(db: Db, organisationId: string, input: RecordAuditInput) {
  const v = RecordAuditInput.parse(input);
  const [row] = await db.insert(schema.auditLog).values({ organisationId, ...v }).returning();
  return row!;
}
```

`packages/core/src/clients/create-client.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const CreateClientInput = z.object({ name: z.string().min(1), email: z.string().email().optional(), phone: z.string().optional() });
export type CreateClientInput = z.infer<typeof CreateClientInput>;

export async function createClient(db: Db, organisationId: string, input: CreateClientInput) {
  const v = CreateClientInput.parse(input);
  const [client] = await db.insert(schema.clients).values({ organisationId, ...v }).returning();
  await recordAudit(db, organisationId, { actorKind: "system", action: "client.created", targetType: "client", targetId: client!.id, after: client });
  return client!;
}
```

`packages/core/src/sites/create-site.ts` follows the same shape with `CreateSiteInput = z.object({ clientId: z.string().uuid(), name: z.string().min(1), primaryUrl: z.string().url() })`, inserting into `schema.sites`, audit action `site.created`.

`packages/core/src/monitoring/create-monitor.ts` with `CreateMonitorInput = z.object({ siteId: z.string().uuid(), target: z.string().url(), intervalSeconds: z.number().int().min(30).default(60) })`, inserting into `schema.monitors`, audit action `monitor.created`.

- [ ] **Step 4: Implement recordCheck**

`packages/core/src/monitoring/record-check.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

export const FAILURE_THRESHOLD = 3;

export const RecordCheckInput = z.object({
  monitorId: z.string().uuid(),
  ok: z.boolean(),
  statusCode: z.number().int().optional(),
  latencyMs: z.number().int().optional(),
  error: z.string().optional(),
});
export type RecordCheckInput = z.infer<typeof RecordCheckInput>;

export async function recordCheck(db: Db, organisationId: string, input: RecordCheckInput) {
  const v = RecordCheckInput.parse(input);
  const [check] = await db.insert(schema.uptimeChecks).values({ organisationId, ...v }).returning();

  const [before] = await db.select({ failures: schema.monitors.consecutiveFailures }).from(schema.monitors)
    .where(and(eq(schema.monitors.id, v.monitorId), eq(schema.monitors.organisationId, organisationId)));
  if (!before) throw new Error(`monitor ${v.monitorId} not found in organisation`);

  const [after] = await db.update(schema.monitors)
    .set({ consecutiveFailures: v.ok ? 0 : sql`${schema.monitors.consecutiveFailures} + 1`, updatedAt: new Date() })
    .where(and(eq(schema.monitors.id, v.monitorId), eq(schema.monitors.organisationId, organisationId)))
    .returning({ failures: schema.monitors.consecutiveFailures });

  const consecutiveFailures = after!.failures;
  return {
    check: check!,
    consecutiveFailures,
    shouldOpenIncident: !v.ok && consecutiveFailures === FAILURE_THRESHOLD,
    shouldResolveIncident: v.ok && before.failures >= FAILURE_THRESHOLD,
  };
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @launchos/core test`
Expected: PASS.

- [ ] **Step 6: Failing test for createTicket, then implement incidents and tickets**

`packages/core/src/support/create-ticket.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClient } from "../clients/create-client.js";
import { createTicket } from "./create-ticket.js";

describe("createTicket", () => {
  it("creates a conversation, a first internal message, the ticket and a created event", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: "t2" }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const { ticket, conversation } = await createTicket(db, org!.id, { clientId: client.id, subject: "Down", body: "Site is down", severity: "high", source: "monitor", category: "hosting" });
      expect(ticket.conversationId).toBe(conversation.id);
      expect(ticket.status).toBe("open");
      const events = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticket.id));
      expect(events.map((e) => e.kind)).toEqual(["created"]);
      const msgs = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversation.id));
      expect(msgs).toHaveLength(1);
    });
  });
});
```

`packages/core/src/support/create-ticket.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";

export const CreateTicketInput = z.object({
  clientId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  category: z.enum(["hosting", "dns", "content", "email", "ads", "billing", "other"]).optional(),
  source: z.enum(["portal", "email", "agent", "monitor", "manual"]),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateTicketInput = z.infer<typeof CreateTicketInput>;

export async function createTicket(db: Db, organisationId: string, input: CreateTicketInput) {
  const v = CreateTicketInput.parse(input);
  const [conversation] = await db.insert(schema.conversations).values({
    organisationId, clientId: v.clientId, siteId: v.siteId ?? null, subject: v.subject, channel: "internal", lastMessageAt: new Date(),
  }).returning();
  await db.insert(schema.messages).values({
    organisationId, conversationId: conversation!.id, direction: "internal", authorKind: v.actorKind, authorId: v.actorId ?? null, body: v.body,
  });
  const [ticket] = await db.insert(schema.tickets).values({
    organisationId, conversationId: conversation!.id, clientId: v.clientId, siteId: v.siteId ?? null,
    subject: v.subject, severity: v.severity, category: v.category ?? null, source: v.source,
  }).returning();
  await db.insert(schema.ticketEvents).values({ organisationId, ticketId: ticket!.id, kind: "created", actorKind: v.actorKind, actorId: v.actorId ?? null });
  await recordAudit(db, organisationId, { actorKind: v.actorKind, actorId: v.actorId, action: "ticket.created", targetType: "ticket", targetId: ticket!.id, after: ticket });
  await emit({ name: "ticket.created", organisationId, ticketId: ticket!.id });
  return { ticket: ticket!, conversation: conversation! };
}
```

`packages/core/src/incidents/open-incident.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";

export const OpenIncidentInput = z.object({
  siteId: z.string().uuid(), monitorId: z.string().uuid().optional(), title: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).default("high"),
});
export type OpenIncidentInput = z.infer<typeof OpenIncidentInput>;

export async function openIncident(db: Db, organisationId: string, input: OpenIncidentInput) {
  const v = OpenIncidentInput.parse(input);
  const [incident] = await db.insert(schema.incidents).values({ organisationId, ...v, monitorId: v.monitorId ?? null }).returning();
  await recordAudit(db, organisationId, { actorKind: "system", action: "incident.opened", targetType: "incident", targetId: incident!.id, after: incident });
  await emit({ name: "incident.opened", organisationId, incidentId: incident!.id });
  return incident!;
}
```

`packages/core/src/incidents/update-incident.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const UpdateIncidentInput = z.object({
  incidentId: z.string().uuid(),
  status: z.enum(["open", "acknowledged", "resolved"]).optional(),
  summaryMd: z.string().optional(),
  ticketId: z.string().uuid().optional(),
  agentRunId: z.string().uuid().optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type UpdateIncidentInput = z.infer<typeof UpdateIncidentInput>;

export async function updateIncident(db: Db, organisationId: string, input: UpdateIncidentInput) {
  const { incidentId, actorKind, actorId, ...patch } = UpdateIncidentInput.parse(input);
  const where = and(eq(schema.incidents.id, incidentId), eq(schema.incidents.organisationId, organisationId));
  const [before] = await db.select().from(schema.incidents).where(where);
  if (!before) throw new Error(`incident ${incidentId} not found in organisation`);
  const resolvedAt = patch.status === "resolved" ? new Date() : before.resolvedAt;
  const [after] = await db.update(schema.incidents).set({ ...patch, resolvedAt, updatedAt: new Date() }).where(where).returning();
  await recordAudit(db, organisationId, { actorKind, actorId, action: "incident.updated", targetType: "incident", targetId: incidentId, before, after });
  return after!;
}
```

`packages/core/src/events/emit.ts`:
```ts
export type DomainEvent =
  | { name: "incident.opened"; organisationId: string; incidentId: string }
  | { name: "ticket.created"; organisationId: string; ticketId: string };

export type EnqueueFn = (event: DomainEvent) => Promise<void>;
let enqueue: EnqueueFn = async () => {}; // no-op until the worker or web sets one

export function setEnqueue(fn: EnqueueFn) { enqueue = fn; }
export async function emit(event: DomainEvent) { await enqueue(event); }
```

`packages/core/src/index.ts` exports every function and input type above.

- [ ] **Step 7: Run all core tests**

Run: `pnpm --filter @launchos/core test`
Expected: PASS (2 files).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): audit, clients, sites, monitors, recordCheck threshold logic, incidents, tickets, domain events"
```

---

### Task 4: Agent kernel

**Files:**
- Create: `packages/agents/src/kernel/types.ts`, `tool-registry.ts`, `policy-gate.ts`, `run-recorder.ts`, `llm.ts`, `run-agent.ts`, `packages/agents/src/index.ts`
- Test: `packages/agents/src/kernel/policy-gate.test.ts`, `packages/agents/src/kernel/run-agent.test.ts`

**Interfaces:**
- Consumes: `Db`, `schema.agentRuns`, `schema.agentSteps`, `schema.approvals`.
- Produces:
  - `types.ts`: `ToolRisk`, `ToolDefinition`, `AgentTrigger`, `AgentDefinition`, `AgentContext`, `AgentRunResult`, `AgentPolicy = "safe" | "approval_all"`, `Logger = Pick<Console, "info" | "warn" | "error">`
  - `defineTool(def) → ToolDefinition` identity helper for inference
  - `decide(tool: ToolDefinition, policy: AgentPolicy): "execute" | "queue_approval"`
  - `LlmClient { complete(req: LlmRequest): Promise<LlmResponse> }`, `LlmRequest { model, system, messages: MessageParam[], tools: Tool[] }`, `LlmResponse { content: ContentBlock[], stopReason, usage: { inputTokens, outputTokens } }`, `AnthropicLlmClient`, `FakeLlmClient(responses: LlmResponse[])`
  - `runAgent(def: AgentDefinition, opts: { db, organisationId, trigger, payload, llm, policy, logger, now? }): Promise<AgentRunResult>`

- [ ] **Step 1: Types**

`packages/agents/src/kernel/types.ts`:
```ts
import type { Db } from "@launchos/db";
import type { z } from "zod";

export type ToolRisk = "safe" | "requires_approval";
export type AgentPolicy = "safe" | "approval_all";
export type Logger = Pick<Console, "info" | "warn" | "error">;

export interface AgentContext { organisationId: string; runId: string; db: Db; logger: Logger; now: () => Date; }

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  name: string;
  description: string;
  input: TInput;
  risk: ToolRisk;
  execute: (input: z.infer<TInput>, ctx: AgentContext) => Promise<TOutput>;
}
export function defineTool<TInput extends z.ZodTypeAny, TOutput>(def: ToolDefinition<TInput, TOutput>) { return def; }

export type AgentTrigger =
  | { kind: "cron"; schedule: string; timezone: string }
  | { kind: "event"; event: string }
  | { kind: "manual" };

export interface AgentDefinition {
  key: string; name: string; description: string; trigger: AgentTrigger;
  systemPrompt: string; tools: ToolDefinition[]; maxTurns: number; model?: string;
}

export interface AgentRunResult { runId: string; status: "completed" | "awaiting_approval" | "failed"; summary: string; }
```

- [ ] **Step 2: Failing policy-gate test**

`packages/agents/src/kernel/policy-gate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decide } from "./policy-gate.js";
import { defineTool } from "./types.js";

const safeTool = defineTool({ name: "a", description: "", input: z.object({}), risk: "safe", execute: async () => ({}) });
const riskyTool = defineTool({ name: "b", description: "", input: z.object({}), risk: "requires_approval", execute: async () => ({}) });

describe("decide", () => {
  it("executes safe tools and queues risky tools under the safe policy", () => {
    expect(decide(safeTool, "safe")).toBe("execute");
    expect(decide(riskyTool, "safe")).toBe("queue_approval");
  });
  it("queues everything under approval_all", () => {
    expect(decide(safeTool, "approval_all")).toBe("queue_approval");
    expect(decide(riskyTool, "approval_all")).toBe("queue_approval");
  });
});
```

- [ ] **Step 3: Run to verify it fails, then implement**

Run: `pnpm --filter @launchos/agents test -- policy-gate` → FAIL (module not found).

`packages/agents/src/kernel/policy-gate.ts`:
```ts
import type { AgentPolicy, ToolDefinition } from "./types.js";
export type PolicyDecision = "execute" | "queue_approval";
export function decide(tool: ToolDefinition, policy: AgentPolicy): PolicyDecision {
  if (policy === "approval_all") return "queue_approval";
  return tool.risk === "safe" ? "execute" : "queue_approval";
}
```
Run again → PASS.

- [ ] **Step 4: Tool registry and LLM client**

`packages/agents/src/kernel/tool-registry.ts`:
```ts
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export function toClaudeTools(tools: ToolDefinition[]): Anthropic.Beta.BetaTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.input) as Anthropic.Beta.BetaTool["input_schema"],
    strict: true,
  }));
}
export function findTool(tools: ToolDefinition[], name: string) { return tools.find((t) => t.name === name); }
```
Tool names must match `^[a-zA-Z0-9_-]{1,64}$`, so use underscores: `uptime_check_site`, not dots.

`packages/agents/src/kernel/llm.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";

export interface LlmRequest {
  model: string; system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}
export interface LlmResponse {
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}
export interface LlmClient { complete(req: LlmRequest): Promise<LlmResponse>; }

export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly client = new Anthropic()) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.beta.messages.create({
      model: req.model, max_tokens: 16000, system: req.system, messages: req.messages, tools: req.tools,
      thinking: { type: "adaptive" },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    });
    return { content: res.content, stopReason: res.stop_reason, usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
  }
}

export class FakeLlmClient implements LlmClient {
  public readonly requests: LlmRequest[] = [];
  constructor(private readonly responses: LlmResponse[]) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const next = this.responses.shift();
    if (!next) throw new Error("FakeLlmClient: no scripted response left");
    return next;
  }
}

export const text = (t: string): Anthropic.Beta.BetaContentBlock => ({ type: "text", text: t, citations: null } as Anthropic.Beta.BetaContentBlock);
export const toolUse = (id: string, name: string, input: unknown): Anthropic.Beta.BetaContentBlock => ({ type: "tool_use", id, name, input } as Anthropic.Beta.BetaContentBlock);
```
If `tsc` reports that a field name differs in the installed SDK version (for example the fallbacks parameter), fix the name from the SDK's type definitions in `node_modules/@anthropic-ai/sdk/resources/beta/messages`. Do not remove the fallback setting.

- [ ] **Step 5: Run recorder**

`packages/agents/src/kernel/run-recorder.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";

export class RunRecorder {
  private seq = 0;
  private constructor(private readonly db: Db, readonly organisationId: string, readonly runId: string) {}

  static async open(db: Db, organisationId: string, agentKey: string, trigger: "cron" | "event" | "manual" | "resume", input: Record<string, unknown>) {
    const [run] = await db.insert(schema.agentRuns).values({ organisationId, agentKey, trigger, input }).returning();
    return new RunRecorder(db, organisationId, run!.id);
  }

  async step(kind: "llm" | "tool_call" | "tool_result" | "approval_requested" | "note", data: { toolName?: string; input?: unknown; output?: unknown; tokensIn?: number; tokensOut?: number }) {
    this.seq += 1;
    const [row] = await this.db.insert(schema.agentSteps).values({
      organisationId: this.organisationId, runId: this.runId, seq: this.seq, kind,
      toolName: data.toolName ?? null, input: data.input ?? {}, output: data.output ?? {},
      tokensIn: data.tokensIn ?? null, tokensOut: data.tokensOut ?? null,
    }).returning();
    return row!;
  }

  async addTokens(tokensIn: number, tokensOut: number) {
    const [run] = await this.db.select({ i: schema.agentRuns.tokensIn, o: schema.agentRuns.tokensOut }).from(schema.agentRuns).where(eq(schema.agentRuns.id, this.runId));
    await this.db.update(schema.agentRuns).set({ tokensIn: (run?.i ?? 0) + tokensIn, tokensOut: (run?.o ?? 0) + tokensOut }).where(eq(schema.agentRuns.id, this.runId));
  }

  async finish(status: "completed" | "awaiting_approval" | "failed", summary: string, error?: string, pending?: Record<string, unknown>) {
    await this.db.update(schema.agentRuns).set({
      status, summary, error: error ?? null, finishedAt: status === "awaiting_approval" ? null : new Date(),
      metadata: pending ? { pending } : {},
    }).where(eq(schema.agentRuns.id, this.runId));
  }
}
```

- [ ] **Step 6: Failing run-agent test**

`packages/agents/src/kernel/run-agent.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { FakeLlmClient, text, toolUse } from "./llm.js";
import { runAgent } from "./run-agent.js";
import { defineTool, type AgentDefinition } from "./types.js";

const calls: unknown[] = [];
const ping = defineTool({ name: "ping", description: "ping", input: z.object({ host: z.string() }), risk: "safe",
  execute: async (input) => { calls.push(input); return { ok: true, host: input.host }; } });
const sendMail = defineTool({ name: "send_mail", description: "send", input: z.object({ to: z.string() }), risk: "requires_approval",
  execute: async () => ({ sent: true }) });

const agent: AgentDefinition = { key: "test-agent", name: "Test", description: "", trigger: { kind: "manual" }, systemPrompt: "You test.", tools: [ping, sendMail], maxTurns: 3 };

describe("runAgent", () => {
  it("executes a safe tool, returns the result to the model, and completes with the final text", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: "t3" }).returning();
      const llm = new FakeLlmClient([
        { content: [toolUse("tu_1", "ping", { host: "a.test" })], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
        { content: [text("a.test is up")], stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 4 } },
      ]);
      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: { host: "a.test" }, llm, policy: "safe", logger: console });
      expect(result.status).toBe("completed");
      expect(result.summary).toBe("a.test is up");
      expect(calls).toEqual([{ host: "a.test" }]);
      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId)).orderBy(schema.agentSteps.seq);
      expect(steps.map((s) => s.kind)).toEqual(["llm", "tool_call", "tool_result", "llm"]);
      const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, result.runId));
      expect(run!.tokensIn).toBe(30);
      // second request carries the tool result back to the model
      const second = llm.requests[1]!;
      const last = second.messages[second.messages.length - 1]!;
      expect(last.role).toBe("user");
    });
  });

  it("parks the run as awaiting_approval when a requires_approval tool is called", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: "t4" }).returning();
      const llm = new FakeLlmClient([
        { content: [toolUse("tu_2", "send_mail", { to: "x@y.test" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
      expect(result.status).toBe("awaiting_approval");
      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, result.runId));
      expect(approval!.status).toBe("pending");
      expect(approval!.payload).toMatchObject({ toolName: "send_mail", input: { to: "x@y.test" } });
    });
  });

  it("fails the run when the tool input is invalid and the model never finishes", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: "t5" }).returning();
      const llm = new FakeLlmClient([
        { content: [toolUse("tu_3", "ping", { nope: 1 })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("tu_4", "ping", { nope: 1 })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("tu_5", "ping", { nope: 1 })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(/maxTurns/);
    });
  });
});
```

- [ ] **Step 7: Run to verify it fails, then implement runAgent**

Run: `pnpm --filter @launchos/agents test -- run-agent` → FAIL.

`packages/agents/src/kernel/run-agent.ts`:
```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { decide } from "./policy-gate.js";
import { RunRecorder } from "./run-recorder.js";
import { findTool, toClaudeTools } from "./tool-registry.js";
import type { LlmClient } from "./llm.js";
import type { AgentContext, AgentDefinition, AgentPolicy, AgentRunResult, Logger } from "./types.js";

export interface RunAgentOptions {
  db: Db; organisationId: string; trigger: "cron" | "event" | "manual" | "resume";
  payload: Record<string, unknown>; llm: LlmClient; policy: AgentPolicy; logger: Logger; now?: () => Date;
}

type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;

export async function runAgent(def: AgentDefinition, opts: RunAgentOptions): Promise<AgentRunResult> {
  const recorder = await RunRecorder.open(opts.db, opts.organisationId, def.key, opts.trigger, opts.payload);
  const ctx: AgentContext = { organisationId: opts.organisationId, runId: recorder.runId, db: opts.db, logger: opts.logger, now: opts.now ?? (() => new Date()) };
  const tools = toClaudeTools(def.tools);
  const model = def.model ?? process.env.AGENT_MODEL ?? "claude-opus-5";
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: JSON.stringify(opts.payload) }];

  try {
    for (let turn = 0; turn < def.maxTurns; turn++) {
      const res = await opts.llm.complete({ model, system: def.systemPrompt, messages, tools });
      await recorder.step("llm", { output: res.content, tokensIn: res.usage.inputTokens, tokensOut: res.usage.outputTokens });
      await recorder.addTokens(res.usage.inputTokens, res.usage.outputTokens);
      messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });

      if (res.stopReason === "refusal") {
        await recorder.finish("failed", "Model refused the request", "refusal");
        return { runId: recorder.runId, status: "failed", summary: "Model refused the request" };
      }
      if (res.stopReason !== "tool_use") {
        const summary = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
        await recorder.finish("completed", summary);
        return { runId: recorder.runId, status: "completed", summary };
      }

      const uses = res.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlock[];
      const outcome = await handleToolUses(def, uses, ctx, recorder, opts.policy);
      if (outcome.parked) {
        await recorder.finish("awaiting_approval", outcome.summary, undefined, { messages, pendingToolUseIds: uses.map((u) => u.id) });
        return { runId: recorder.runId, status: "awaiting_approval", summary: outcome.summary };
      }
      messages.push({ role: "user", content: outcome.results });
    }
    await recorder.finish("failed", `Stopped after maxTurns=${def.maxTurns}`, "max_turns");
    return { runId: recorder.runId, status: "failed", summary: `Stopped after maxTurns=${def.maxTurns}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.logger.error({ runId: recorder.runId, err: message }, "agent run failed");
    await recorder.finish("failed", "Run failed", message);
    return { runId: recorder.runId, status: "failed", summary: message };
  }
}

async function handleToolUses(def: AgentDefinition, uses: Anthropic.Beta.BetaToolUseBlock[], ctx: AgentContext, recorder: RunRecorder, policy: AgentPolicy) {
  const results: ToolResultBlock[] = [];
  for (const use of uses) {
    const tool = findTool(def.tools, use.name);
    if (!tool) { results.push({ type: "tool_result", tool_use_id: use.id, content: `Unknown tool ${use.name}`, is_error: true }); continue; }
    const parsed = tool.input.safeParse(use.input);
    if (!parsed.success) {
      await recorder.step("tool_call", { toolName: tool.name, input: use.input, output: { error: parsed.error.message } });
      results.push({ type: "tool_result", tool_use_id: use.id, content: `Invalid input: ${parsed.error.message}`, is_error: true });
      continue;
    }
    if (decide(tool, policy) === "queue_approval") {
      const step = await recorder.step("approval_requested", { toolName: tool.name, input: parsed.data });
      await ctx.db.insert(schema.approvals).values({
        organisationId: ctx.organisationId, runId: ctx.runId, stepId: step.id, kind: "tool_call",
        title: `${def.name} wants to run ${tool.name}`, payload: { toolName: tool.name, input: parsed.data, toolUseId: use.id },
      });
      return { parked: true, summary: `Awaiting approval for ${tool.name}`, results };
    }
    await recorder.step("tool_call", { toolName: tool.name, input: parsed.data });
    const output = await tool.execute(parsed.data, ctx);
    await recorder.step("tool_result", { toolName: tool.name, output });
    results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(output) });
  }
  return { parked: false, summary: "", results };
}
```

`packages/agents/src/index.ts` exports everything from `kernel/*`.

- [ ] **Step 8: Run kernel tests and typecheck**

Run: `pnpm --filter @launchos/agents test && pnpm --filter @launchos/agents typecheck`
Expected: PASS. Fix any SDK type-name drift reported by `tsc` using the installed SDK's `.d.ts` files.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(agents): kernel with typed tools, policy gate, run recorder, Anthropic and fake LLM clients, tool loop"
```

---

### Task 5: Integrations (mock-first) and Hosting Guard-Dog agent

**Files:**
- Create: `packages/integrations/src/uptime/index.ts`, `packages/integrations/src/coolify/index.ts`, `packages/integrations/src/index.ts`
- Create: `packages/agents/src/tools/uptime-check-site.ts`, `hosting-get-resources.ts`, `incidents-update.ts`, `tickets-create.ts`
- Create: `packages/agents/src/agents/hosting-guard-dog/index.ts`, `packages/agents/src/agents/index.ts`
- Test: `packages/agents/src/agents/hosting-guard-dog/hosting-guard-dog.test.ts`

**Interfaces:**
- Produces:
  - `UptimeProbe { check(url: string): Promise<{ ok: boolean; statusCode?: number; latencyMs?: number; error?: string }> }`, `MockUptimeProbe(downUrls: Set<string>)`, `HttpUptimeProbe`
  - `HostingProvider { getResources(ref: string): Promise<{ cpuPercent: number; memoryPercent: number; diskPercent: number; lastDeployAt: string; status: "running" | "exited" | "restarting" }> }`, `MockHostingProvider(overrides?)`
  - `createIntegrations(env: NodeJS.ProcessEnv): { uptime: UptimeProbe; hosting: HostingProvider }`
  - `makeGuardDogTools(integrations) → ToolDefinition[]`, `hostingGuardDog(integrations): AgentDefinition`, `agentRegistry(integrations): Record<string, AgentDefinition>`

- [ ] **Step 1: Integrations**

`packages/integrations/src/uptime/index.ts`:
```ts
export interface UptimeResult { ok: boolean; statusCode?: number; latencyMs?: number; error?: string; }
export interface UptimeProbe { check(url: string): Promise<UptimeResult>; }

export class MockUptimeProbe implements UptimeProbe {
  constructor(public readonly downUrls = new Set<string>()) {}
  async check(url: string): Promise<UptimeResult> {
    return this.downUrls.has(url) ? { ok: false, statusCode: 503, latencyMs: 30000, error: "503 Service Unavailable" } : { ok: true, statusCode: 200, latencyMs: 120 };
  }
}

export class HttpUptimeProbe implements UptimeProbe {
  constructor(private readonly timeoutMs = 10000) {}
  async check(url: string): Promise<UptimeResult> {
    const started = Date.now();
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
      return { ok: res.status < 500, statusCode: res.status, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

`packages/integrations/src/coolify/index.ts`:
```ts
export interface HostingResources { cpuPercent: number; memoryPercent: number; diskPercent: number; lastDeployAt: string; status: "running" | "exited" | "restarting"; }
export interface HostingProvider { getResources(ref: string): Promise<HostingResources>; }

export class MockHostingProvider implements HostingProvider {
  constructor(private readonly overrides: Record<string, Partial<HostingResources>> = {}) {}
  async getResources(ref: string): Promise<HostingResources> {
    return { cpuPercent: 12, memoryPercent: 41, diskPercent: 55, lastDeployAt: "2026-09-01T09:00:00Z", status: "running", ...this.overrides[ref] };
  }
}
```

`packages/integrations/src/index.ts`:
```ts
import { HttpUptimeProbe, MockUptimeProbe, type UptimeProbe } from "./uptime/index.js";
import { MockHostingProvider, type HostingProvider } from "./coolify/index.js";
export * from "./uptime/index.js";
export * from "./coolify/index.js";

export interface Integrations { uptime: UptimeProbe; hosting: HostingProvider; }
export function createIntegrations(env: NodeJS.ProcessEnv): Integrations {
  const uptime = env.UPTIME_PROBE === "http" ? new HttpUptimeProbe() : new MockUptimeProbe();
  const hosting = new MockHostingProvider(); // real Coolify client arrives with a later plan
  return { uptime, hosting };
}
```
Add `UPTIME_PROBE=mock` to `.env.example` with a comment (`mock | http`).

- [ ] **Step 2: Tools**

`packages/agents/src/tools/uptime-check-site.ts`:
```ts
import { z } from "zod";
import type { UptimeProbe } from "@launchos/integrations";
import { defineTool } from "../kernel/types.js";
export const uptimeCheckSite = (probe: UptimeProbe) => defineTool({
  name: "uptime_check_site", description: "Perform a live HTTP check of a URL and return status, latency and any error.",
  input: z.object({ url: z.string().url() }), risk: "safe",
  execute: async ({ url }) => probe.check(url),
});
```
`packages/agents/src/tools/hosting-get-resources.ts`: same shape, name `hosting_get_resources`, input `{ hostingRef: z.string() }`, calls `hosting.getResources`.

`packages/agents/src/tools/incidents-update.ts`:
```ts
import { z } from "zod";
import { updateIncident } from "@launchos/core";
import { defineTool } from "../kernel/types.js";
export const incidentsUpdate = defineTool({
  name: "incidents_update", description: "Update an incident's status and Markdown summary.",
  input: z.object({ incidentId: z.string().uuid(), status: z.enum(["open", "acknowledged", "resolved"]).optional(), summaryMd: z.string().optional() }),
  risk: "safe",
  execute: async (input, ctx) => updateIncident(ctx.db, ctx.organisationId, { ...input, agentRunId: ctx.runId, actorKind: "agent", actorId: "hosting-guard-dog" }),
});
```
`packages/agents/src/tools/tickets-create.ts`: name `tickets_create`, input `{ clientId uuid, siteId uuid optional, subject, body, severity enum default "high", category enum default "hosting" }`, risk `safe`, calls `createTicket(ctx.db, ctx.organisationId, { ...input, source: "agent", actorKind: "agent", actorId: "hosting-guard-dog" })` and returns `{ ticketId: result.ticket.id }`.

- [ ] **Step 3: Failing agent test**

`packages/agents/src/agents/hosting-guard-dog/hosting-guard-dog.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClient, createMonitor, createSite, openIncident } from "@launchos/core";
import { MockHostingProvider, MockUptimeProbe } from "@launchos/integrations";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
import { runAgent } from "../../kernel/run-agent.js";
import { hostingGuardDog } from "./index.js";

describe("hosting-guard-dog", () => {
  it("diagnoses an open incident, opens a ticket and acknowledges the incident", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: "gd" }).returning();
      const client = await createClient(db, org!.id, { name: "Grays CabLine" });
      const site = await createSite(db, org!.id, { clientId: client.id, name: "grayscabline.co.uk", primaryUrl: "https://grayscabline.co.uk" });
      const monitor = await createMonitor(db, org!.id, { siteId: site.id, target: site.primaryUrl });
      const incident = await openIncident(db, org!.id, { siteId: site.id, monitorId: monitor.id, title: "grayscabline.co.uk is down" });

      const integrations = { uptime: new MockUptimeProbe(new Set([site.primaryUrl])), hosting: new MockHostingProvider({ app_1: { status: "exited" } }) };
      const agent = hostingGuardDog(integrations);
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "uptime_check_site", { url: site.primaryUrl }), toolUse("t2", "hosting_get_resources", { hostingRef: "app_1" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("t3", "tickets_create", { clientId: client.id, siteId: site.id, subject: "Site down: container exited", body: "Container exited; 503 from origin.", severity: "critical", category: "hosting" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("t4", "incidents_update", { incidentId: incident.id, status: "acknowledged", summaryMd: "## Diagnosis\nContainer exited." })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [text("Acknowledged incident and opened a critical ticket.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "event", payload: { incidentId: incident.id, siteId: site.id, clientId: client.id, url: site.primaryUrl, hostingRef: "app_1" }, llm, policy: "safe", logger: console });
      expect(result.status).toBe("completed");

      const [updated] = await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id));
      expect(updated!.status).toBe("acknowledged");
      expect(updated!.agentRunId).toBe(result.runId);
      const tickets = await db.select().from(schema.tickets).where(eq(schema.tickets.siteId, site.id));
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.severity).toBe("critical");
      expect(tickets[0]!.source).toBe("agent");
    });
  });
});
```

- [ ] **Step 4: Run to verify it fails, then implement the agent**

`packages/agents/src/agents/hosting-guard-dog/index.ts`:
```ts
import type { Integrations } from "@launchos/integrations";
import type { AgentDefinition } from "../../kernel/types.js";
import { uptimeCheckSite } from "../../tools/uptime-check-site.js";
import { hostingGetResources } from "../../tools/hosting-get-resources.js";
import { incidentsUpdate } from "../../tools/incidents-update.js";
import { ticketsCreate } from "../../tools/tickets-create.js";

export const HOSTING_GUARD_DOG_PROMPT = `You are the Hosting Guard-Dog for a UK web agency. An incident has been opened because a monitored site failed its uptime check three times in a row.

Your job, in order:
1. Confirm the outage with uptime_check_site on the site URL.
2. Inspect hosting with hosting_get_resources using the hostingRef.
3. Create one internal ticket with tickets_create: subject states the site and the most likely cause; body is a short Markdown diagnosis with the evidence you gathered; severity "critical" if the site is fully down, "high" if degraded.
4. Update the incident with incidents_update: status "acknowledged" and a Markdown summary (Diagnosis, Evidence, Recommended next step).
Finish with one sentence describing what you did. Do not invent evidence. If the site responds OK on your check, say so, set severity "medium", and still acknowledge the incident.`;

export function hostingGuardDog(integrations: Integrations): AgentDefinition {
  return {
    key: "hosting-guard-dog",
    name: "Hosting Guard-Dog",
    description: "Diagnoses site outages, opens an internal ticket and acknowledges the incident.",
    trigger: { kind: "event", event: "incident.opened" },
    systemPrompt: HOSTING_GUARD_DOG_PROMPT,
    tools: [uptimeCheckSite(integrations.uptime), hostingGetResources(integrations.hosting), ticketsCreate, incidentsUpdate],
    maxTurns: 8,
  };
}
```

`packages/agents/src/agents/index.ts`:
```ts
import type { Integrations } from "@launchos/integrations";
import type { AgentDefinition } from "../kernel/types.js";
import { hostingGuardDog } from "./hosting-guard-dog/index.js";
export function agentRegistry(integrations: Integrations): Record<string, AgentDefinition> {
  const defs = [hostingGuardDog(integrations)];
  return Object.fromEntries(defs.map((d) => [d.key, d]));
}
```
Export from `packages/agents/src/index.ts`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @launchos/agents test`
Expected: PASS (3 files).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(agents): mock uptime and hosting integrations, guard-dog tools and agent definition"
```

---

### Task 6: Worker: pg-boss, monitor cron, agent runs

**Files:**
- Create: `apps/worker/src/env.ts`, `apps/worker/src/boss.ts`, `apps/worker/src/jobs/monitor-check.ts`, `apps/worker/src/jobs/agent-run.ts`, `apps/worker/src/index.ts`
- Test: `apps/worker/src/jobs/monitor-check.test.ts`

**Interfaces:**
- Consumes: `recordCheck`, `openIncident`, `updateIncident`, `setEnqueue`, `runAgent`, `agentRegistry`, `createIntegrations`.
- Produces: `runMonitorSweep(db, organisationId, probe) → { checked, incidentsOpened, incidentsResolved }`, `handleAgentRun(deps, job)`, queue names `QUEUE.monitorCheck = "monitor.check"`, `QUEUE.agentRun = "agent.run"`.

- [ ] **Step 1: Env and boss**

`apps/worker/src/env.ts`:
```ts
import { z } from "zod";
export const Env = z.object({
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AGENT_MODEL: z.string().default("claude-opus-5"),
  AGENT_POLICY: z.enum(["safe", "approval_all"]).default("safe"),
  UPTIME_PROBE: z.enum(["mock", "http"]).default("mock"),
  LLM: z.enum(["anthropic", "fake"]).default("anthropic"),
});
export type Env = z.infer<typeof Env>;
export const env = Env.parse(process.env);
```

`apps/worker/src/boss.ts`:
```ts
import PgBoss from "pg-boss";
export const QUEUE = { monitorCheck: "monitor.check", agentRun: "agent.run" } as const;
export async function createBoss(connectionString: string) {
  const boss = new PgBoss({ connectionString, schema: "pgboss", retryLimit: 5, retryBackoff: true });
  boss.on("error", (e) => console.error("pg-boss error", e));
  await boss.start();
  for (const q of Object.values(QUEUE)) await boss.createQueue(q);
  return boss;
}
```

- [ ] **Step 2: Failing monitor sweep test**

`apps/worker/src/jobs/monitor-check.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClient, createMonitor, createSite } from "@launchos/core";
import { MockUptimeProbe } from "@launchos/integrations";
import { runMonitorSweep } from "./monitor-check.js";

describe("runMonitorSweep", () => {
  it("opens one incident after three failing sweeps and resolves it when the site recovers", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: "mw" }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const site = await createSite(db, org!.id, { clientId: client.id, name: "S", primaryUrl: "https://s.test" });
      await createMonitor(db, org!.id, { siteId: site.id, target: "https://s.test" });
      const probe = new MockUptimeProbe(new Set(["https://s.test"]));

      const r1 = await runMonitorSweep(db, org!.id, probe);
      const r2 = await runMonitorSweep(db, org!.id, probe);
      const r3 = await runMonitorSweep(db, org!.id, probe);
      expect([r1.incidentsOpened, r2.incidentsOpened, r3.incidentsOpened]).toEqual([0, 0, 1]);
      expect(r3.checked).toBe(1);

      probe.downUrls.clear();
      const r4 = await runMonitorSweep(db, org!.id, probe);
      expect(r4.incidentsResolved).toBe(1);
      const incidents = await db.select().from(schema.incidents).where(eq(schema.incidents.siteId, site.id));
      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.status).toBe("resolved");
    });
  });
});
```

- [ ] **Step 3: Implement the sweep**

`apps/worker/src/jobs/monitor-check.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import { openIncident, recordCheck, updateIncident } from "@launchos/core";
import type { UptimeProbe } from "@launchos/integrations";

export async function runMonitorSweep(db: Db, organisationId: string, probe: UptimeProbe) {
  const monitors = await db.select().from(schema.monitors)
    .where(and(eq(schema.monitors.organisationId, organisationId), eq(schema.monitors.enabled, true), isNull(schema.monitors.deletedAt)));
  let incidentsOpened = 0, incidentsResolved = 0;
  for (const m of monitors) {
    const probeResult = await probe.check(m.target);
    const outcome = await recordCheck(db, organisationId, { monitorId: m.id, ...probeResult });
    if (outcome.shouldOpenIncident) {
      await openIncident(db, organisationId, { siteId: m.siteId, monitorId: m.id, title: `${m.target} is down`, severity: "critical" });
      incidentsOpened += 1;
    }
    if (outcome.shouldResolveIncident) {
      const open = await db.select({ id: schema.incidents.id }).from(schema.incidents)
        .where(and(eq(schema.incidents.monitorId, m.id), ne(schema.incidents.status, "resolved")));
      for (const inc of open) { await updateIncident(db, organisationId, { incidentId: inc.id, status: "resolved" }); incidentsResolved += 1; }
    }
  }
  return { checked: monitors.length, incidentsOpened, incidentsResolved };
}
```
Run: `pnpm --filter @launchos/worker test` → PASS.

- [ ] **Step 4: Agent run job and index**

`apps/worker/src/jobs/agent-run.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { runAgent, type AgentDefinition, type AgentPolicy, type LlmClient } from "@launchos/agents";

export interface AgentRunJob { agentKey: string; organisationId: string; trigger: "cron" | "event" | "manual"; payload: Record<string, unknown>; }
export interface AgentRunDeps { db: Db; registry: Record<string, AgentDefinition>; llm: LlmClient; policy: AgentPolicy; logger: Console; }

export async function handleAgentRun(deps: AgentRunDeps, job: AgentRunJob) {
  const def = deps.registry[job.agentKey];
  if (!def) throw new Error(`unknown agent ${job.agentKey}`);
  const [enablement] = await deps.db.select().from(schema.agentEnablement)
    .where(and(eq(schema.agentEnablement.organisationId, job.organisationId), eq(schema.agentEnablement.agentKey, job.agentKey)));
  if (!enablement?.enabled) { deps.logger.info(`agent ${job.agentKey} disabled for ${job.organisationId}; skipping`); return; }
  const policy = (enablement.config as { policy?: AgentPolicy }).policy ?? deps.policy;
  return runAgent(def, { db: deps.db, organisationId: job.organisationId, trigger: job.trigger, payload: job.payload, llm: deps.llm, policy, logger: deps.logger });
}

/** Builds the guard-dog payload from an incident id. */
export async function incidentPayload(db: Db, organisationId: string, incidentId: string) {
  const [row] = await db.select({ incidentId: schema.incidents.id, siteId: schema.sites.id, clientId: schema.sites.clientId, url: schema.sites.primaryUrl, hostingRef: schema.sites.hostingRef })
    .from(schema.incidents).innerJoin(schema.sites, eq(schema.sites.id, schema.incidents.siteId))
    .where(and(eq(schema.incidents.id, incidentId), eq(schema.incidents.organisationId, organisationId)));
  if (!row) throw new Error(`incident ${incidentId} not found`);
  return { ...row, hostingRef: row.hostingRef ?? "unknown" };
}
```

`apps/worker/src/index.ts`:
```ts
import { createDb, schema } from "@launchos/db";
import { setEnqueue } from "@launchos/core";
import { AnthropicLlmClient, FakeLlmClient, agentRegistry } from "@launchos/agents";
import { createIntegrations } from "@launchos/integrations";
import { env } from "./env.js";
import { QUEUE, createBoss } from "./boss.js";
import { runMonitorSweep } from "./jobs/monitor-check.js";
import { handleAgentRun, incidentPayload, type AgentRunJob } from "./jobs/agent-run.js";

async function main() {
  const db = createDb(env.DATABASE_URL);
  const boss = await createBoss(env.DATABASE_URL);
  const integrations = createIntegrations(process.env);
  const registry = agentRegistry(integrations);
  const llm = env.LLM === "fake" ? new FakeLlmClient([]) : new AnthropicLlmClient();

  setEnqueue(async (event) => {
    if (event.name === "incident.opened") {
      const payload = await incidentPayload(db, event.organisationId, event.incidentId);
      const job: AgentRunJob = { agentKey: "hosting-guard-dog", organisationId: event.organisationId, trigger: "event", payload };
      await boss.send(QUEUE.agentRun, job, { singletonKey: `guard-dog:${event.incidentId}` });
    }
  });

  await boss.work(QUEUE.monitorCheck, async () => {
    const orgs = await db.select({ id: schema.organisations.id }).from(schema.organisations);
    for (const org of orgs) {
      const r = await runMonitorSweep(db, org.id, integrations.uptime);
      console.info({ org: org.id, ...r }, "monitor sweep");
    }
  });
  await boss.work<AgentRunJob>(QUEUE.agentRun, async ([job]) => {
    const result = await handleAgentRun({ db, registry, llm, policy: env.AGENT_POLICY, logger: console }, job!.data);
    console.info({ result }, "agent run");
  });
  await boss.schedule(QUEUE.monitorCheck, "* * * * *", {}, { tz: "Europe/London" });
  console.info("worker started");
}
main().catch((e) => { console.error(e); process.exit(1); });
```
If the installed pg-boss version's `work` handler receives a single job instead of an array, adjust to `async (job) => job.data`. Check `node_modules/pg-boss/types.d.ts`.

- [ ] **Step 5: Smoke run locally**

Run in one terminal: `pnpm db:up && pnpm db:migrate && LLM=fake pnpm dev:worker` (PowerShell: `$env:LLM="fake"; pnpm dev:worker`).
Expected: log line `worker started`, then a `monitor sweep` line each minute with `checked: 0`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): pg-boss boot, minute monitor sweep, incident-triggered guard-dog runs"
```

---

### Task 7: Web app: Next.js, Better Auth, session, admin screens

**Files:**
- Create: `apps/web` via `pnpm create next-app@latest web --ts --tailwind --eslint --app --src-dir --no-import-alias` run inside `apps/`, then rename the package to `@launchos/web`
- Create: `apps/web/src/lib/db.ts`, `apps/web/src/lib/auth.ts`, `apps/web/src/lib/session.ts`, `apps/web/src/app/api/auth/[...all]/route.ts`, `apps/web/src/app/api/health/route.ts`
- Create: `apps/web/src/app/(admin)/layout.tsx`, `(admin)/page.tsx`, `(admin)/incidents/page.tsx`, `(admin)/incidents/[id]/page.tsx`, `(admin)/tickets/page.tsx`, `(admin)/agents/runs/[id]/page.tsx`, `(admin)/approvals/page.tsx`, `(admin)/settings/agents/page.tsx`
- Create: `apps/web/src/app/sign-in/page.tsx`
- Create: `packages/db/src/seed.ts`
- Test: `apps/web/tests/e2e/admin-incidents.spec.ts` (Playwright)

**Interfaces:**
- Produces: `getSession() → { userId, email, organisationId, role: "owner" | "staff" } | null`, `requireAdmin()` that redirects to `/sign-in`.
- Consumes: `schema.*`, `updateIncident`, `createDb`.

- [ ] **Step 1: Scaffold and wire the DB**

Run inside `apps/`: `pnpm create next-app@latest web --ts --tailwind --eslint --app --src-dir --no-import-alias`. Set `"name": "@launchos/web"` and add dependencies `@launchos/db`, `@launchos/core`, `better-auth`, `drizzle-orm`, `postgres`, `zod`. Add `npx shadcn@latest init` with the default neutral theme and add `button card table badge`.

`apps/web/src/lib/db.ts`:
```ts
import { createDb } from "@launchos/db";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
export const db = createDb(url);
```

- [ ] **Step 2: Better Auth**

`apps/web/src/lib/auth.ts`:
```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db";
import { schema } from "@launchos/db";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification } }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
});
```
`apps/web/src/app/api/auth/[...all]/route.ts`:
```ts
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
export const { GET, POST } = toNextJsHandler(auth);
```
Run `pnpm dlx @better-auth/cli@latest generate --config src/lib/auth.ts` from `apps/web` and copy the generated Drizzle tables into `packages/db/src/schema/auth.ts`, replacing the hand-written version from Task 2. Run `pnpm db:generate && pnpm db:migrate`; expect a no-op or a small diff migration.

`apps/web/src/lib/session.ts`:
```ts
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { auth } from "./auth";
import { db } from "./db";

export async function getSession() {
  const s = await auth.api.getSession({ headers: await headers() });
  if (!s) return null;
  const [m] = await db.select().from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.userId, s.user.id), eq(schema.organisationMembers.status, "active")));
  if (!m) return null;
  return { userId: s.user.id, email: s.user.email, organisationId: m.organisationId, role: m.role };
}
export async function requireAdmin() {
  const s = await getSession();
  if (!s) redirect("/sign-in");
  return s;
}
```

- [ ] **Step 3: Seed**

`packages/db/src/seed.ts` creates: organisation `launchflow`; owner user `shujaat@nexusedu.co.uk` via Better Auth's sign-up API call against a running web app is awkward, so instead the seed inserts the `user` row and an `account` row with `providerId: "credential"` and a password hashed with `better-auth/crypto`'s `hashPassword` (`import { hashPassword } from "better-auth/crypto"`); `organisation_members` row `owner`; client "Grays CabLine" with site `https://grayscabline.co.uk` and monitor; client "Mobile PC Doctor" with site and monitor; `agent_enablement` row `hosting-guard-dog` enabled. Password comes from env `SEED_OWNER_PASSWORD` (default `change-me-now`). Seed is idempotent: it looks up by slug/email before inserting.

Run: `pnpm db:seed` → prints the created ids.

- [ ] **Step 4: Admin pages**

`(admin)/layout.tsx` calls `requireAdmin()` and renders a left nav (Dashboard, Clients, Sites, Tickets, Incidents, Approvals, Agent Runs, Settings) with the white/light shadcn styling.

`(admin)/incidents/page.tsx` server component: selects incidents joined to sites for `session.organisationId` ordered by `openedAt desc`, renders a table with status badge, severity, site, opened time, link to detail.

`(admin)/incidents/[id]/page.tsx`: shows the incident, its `summaryMd` rendered as Markdown (use `react-markdown`), the linked ticket, the last 20 `uptime_checks` for its monitor, and a link to `/agents/runs/[agentRunId]`. Two server actions: `acknowledge` and `resolve` calling `updateIncident` with `actorKind: "user", actorId: session.userId`.

`(admin)/agents/runs/[id]/page.tsx`: run header (agent, status, tokens, started, finished) and a step list ordered by `seq` with input/output rendered as pretty JSON in `<pre>`.

`(admin)/approvals/page.tsx`: pending approvals with Approve/Reject server actions that update `approvals.status`, `decidedBy`, `decidedAt` and record audit. Resuming the parked run is Plan 2; for now approving records the decision only and shows "Resume arrives in Plan 2".

`(admin)/tickets/page.tsx`: table of tickets with severity, status, source, client, created.

`(admin)/settings/agents/page.tsx`: lists `agentRegistry` keys with a toggle that upserts `agent_enablement`.

`sign-in/page.tsx`: email + password form posting to Better Auth's client (`createAuthClient` from `better-auth/react`), redirect to `/` on success.

`api/health/route.ts`: `SELECT 1` then `{ ok: true }`.

- [ ] **Step 5: Playwright test**

`apps/web/tests/e2e/admin-incidents.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
test("owner signs in and sees the incidents table", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(process.env.SEED_OWNER_EMAIL ?? "shujaat@nexusedu.co.uk");
  await page.getByLabel("Password").fill(process.env.SEED_OWNER_PASSWORD ?? "change-me-now");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto("/incidents");
  await expect(page.getByRole("heading", { name: "Incidents" })).toBeVisible();
});
```
Run: `pnpm --filter @launchos/web exec playwright test` with the dev server running → PASS.

- [ ] **Step 6: End-to-end slice by hand**

1. `pnpm db:seed`, `pnpm dev`, `pnpm dev:worker` with `LLM=fake` replaced by a real `ANTHROPIC_API_KEY` and `UPTIME_PROBE=mock`.
2. In psql or Drizzle Studio, set `sites.primary_url` for Grays CabLine to `https://down.example.test` and add that URL to `MockUptimeProbe` via env `MOCK_DOWN_URLS=https://down.example.test` (add this env read to `createIntegrations`).
3. Wait three minutes. Expected: an incident appears at `/incidents`, then within a minute a ticket appears at `/tickets` with source `agent`, the incident becomes `acknowledged` with a Markdown summary, and `/agents/runs/[id]` shows the four tool steps.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): Next.js app with Better Auth, session, seed, admin incidents/tickets/runs/approvals/settings"
```

---

### Task 8: Containers and Coolify

**Files:**
- Create: `infra/Dockerfile.web`, `infra/Dockerfile.worker`, `infra/docker-compose.coolify.yml`
- Modify: `docs/DEPLOYMENT.md` (add exact Coolify steps once verified)

- [ ] **Step 1: Dockerfiles**

`infra/Dockerfile.worker`:
```dockerfile
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @launchos/worker...
COPY apps/worker ./apps/worker
RUN pnpm --filter @launchos/worker... build
CMD ["node", "apps/worker/dist/index.js"]
```
`infra/Dockerfile.web`: same base, `--filter @launchos/web...`, `RUN pnpm --filter @launchos/web build`, `CMD ["sh", "-c", "pnpm --filter @launchos/db migrate && pnpm --filter @launchos/web start"]`, `EXPOSE 3000`.

- [ ] **Step 2: Build both images locally**

Run from repo root: `docker build -f infra/Dockerfile.worker -t launchos-worker . && docker build -f infra/Dockerfile.web -t launchos-web .`
Expected: both build. Run `docker run --rm -e DATABASE_URL=postgres://launchos:launchos@host.docker.internal:5432/launchos -e LLM=fake launchos-worker` and see `worker started`.

- [ ] **Step 3: Coolify**

In Coolify: create project `LaunchOS`, add PostgreSQL 17 resource, add two Docker-build resources from the GitHub repo with the Dockerfile paths above, set env vars from `.env.example`, set the web domain, enable auto-deploy on `main`. Record the exact steps taken in `docs/DEPLOYMENT.md`. Do not push to GitHub until Shoji approves the local run.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(infra): Dockerfiles for web and worker, Coolify deployment notes"
```

---

## Self-review

- **Spec coverage:** Tenancy (Task 2 `tenantColumns`), core contract (Task 3), kernel with policy gate and recording (Task 4), mock-first integrations (Task 5), queue and cron (Task 6), admin portal minimum and auth (Task 7), deploy (Task 8). Client portal, inbox, email channel, Support Triage, Ad Sentinel and approval resume are explicitly Plans 2 and 3.
- **Placeholders:** none; the only deferred items are named as later plans.
- **Type consistency:** `recordCheck` returns `{ check, consecutiveFailures, shouldOpenIncident, shouldResolveIncident }` and is consumed as such in Task 6. `runAgent(def, opts)` signature matches Tasks 4, 5 and 6. Tool names use underscores everywhere. `AgentRunJob.trigger` excludes `resume`, which `RunRecorder.open` also accepts for Plan 2.
