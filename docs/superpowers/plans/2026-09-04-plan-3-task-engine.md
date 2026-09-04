# Plan 3: Task Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "add a client" into a worked plan: packages and task templates describe what a retainer contains, creating a client generates its onboarding task list automatically, a daily cron generates the recurring service work (social posts, blogs, GBP updates, SEO audits) that justifies the monthly fee, and Shoji or a team member works them from a Tasks board, a Tasks list, or the client's own Tasks tab — with overdue work chasing itself through notifications.

**Architecture:** Migration 0004 adds `packages`, `task_templates`, `tasks`, `task_comments` plus `clients.package_id` FK, `clients.onboarded_at`, `clients.handover_at`. `packages/core/src/packages/*` owns the catalogue (packages and templates CRUD); `packages/core/src/tasks/*` owns runtime task services — create, list, status, assign, comment, checklist, generation and overdue detection — all `(db, organisationId, input)`. `apps/worker` maps `client.created` → `tasks.generate-onboarding` and registers two daily crons (`tasks.generate-recurring` 06:00, `tasks.check-overdue` 08:00) on Europe/London. `apps/web` adds `/tasks` (list + board), `/tasks/[id]`, the client detail Tasks tab, and Settings → Packages / Task templates.

**Tech Stack:** Node 24, pnpm 11, TypeScript 5 strict, Next.js 16, React 19, Tailwind 4, shadcn/ui, Drizzle ORM + drizzle-kit, `postgres` driver, Better Auth, pg-boss, Zod 4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-agency-os-full-build.md`

## Global Constraints

- Everything in `CLAUDE.md` still binds: tenancy, approval gate, audit log, mock-first integrations, secrets in env, immutability, file size.
- **Ownership assertions.** Any service taking a foreign id (`clientId`, `siteId`, `taskId`, `templateId`, `packageId`) asserts it belongs to `organisationId` — via Plan 2's generic `assertOwned(db, organisationId, table, id)` in `packages/core/src/tenancy/assert-owned.ts`, or the existing `assertClientInOrganisation` / `assertSiteInOrganisation`.
- **Transactions.** Multi-write services run inside `db.transaction`; domain events emit after commit.
- **Domain events.** Extend `DomainEvent` in `packages/core/src/events/emit.ts`. The worker maps events to jobs; `apps/web/src/lib/queue.ts` maps the same events for web-originated writes so nothing is dropped.
- **Notifications.** Owner is notified in-app for task overdue; the assignee is notified too. Notification rows go through Plan 2's `notify` / `notifyOwner`.
- **UI.** shadcn, white/light, dense but calm tables, page header with primary action, empty states with a call to action, Zod-validated forms with the server action re-validating. Footer "Powered by LaunchFlow".
- **Tests.** Vitest on every core service against real Postgres via `withTestDb` (transaction rolled back). Test data uses random slugs and emails. Playwright smoke for the plan's main flow.
- Every core service signature is `(db: Db, organisationId: string, input)`.
- ESM everywhere: relative imports inside a package carry the `.js` suffix. Tables are reached through the `schema.` namespace (`import { schema } from "@launchos/db"`), never by bare table import.
- Zod input types are `export type X = z.input<typeof X>` when the schema has defaults, `z.infer` otherwise.
- Files 800 lines max; functions under 50 lines.
- Commit after every task with a conventional-commit message.

### Plan 2 interfaces this plan consumes

Plan 2 lands before this plan on branch `build/agency-os` and delivers, by exact name:

| Name | Module | Shape |
|---|---|---|
| `createClient` | `packages/core/src/clients/create-client.ts` | returns the client row including `slug` |
| `recordActivity` | `packages/core/src/activity/record-activity.ts` | `(db, organisationId, { clientId?, siteId?, actorKind, actorId?, kind, title, body?, link? })` |
| `notify` | `packages/core/src/notifications/notify.ts` | `(db, organisationId, { userId, kind, title, body?, link? })` |
| `notifyOwner` | `packages/core/src/notifications/notify.ts` | `(db, organisationId, { kind, title, body?, link? })` |
| `listMembers` | `packages/core/src/team/list-members.ts` | `(db, organisationId)` → active `organisation_members` joined to `user` |
| `assertOwned` | `packages/core/src/tenancy/assert-owned.ts` | `(db, organisationId, table, id)` generic |
| `DomainEvent` | `packages/core/src/events/emit.ts` | includes `{ name: "client.created"; organisationId; clientId }` |
| migration `0003` | `packages/db/drizzle/` | `clients.slug`, `clients.support_email`, `clients.package_id` (plain nullable uuid, no FK), address columns, `billing_profiles`, `notifications`, `activity_events`, `domains.client_id`, team columns on `organisation_members` (`display_name`, `title`, `phone`, `invited_by`, `initial_password_set_at`) |
| admin sidebar | `apps/web/src/app/(admin)/layout.tsx` | nav array with a **disabled** "Tasks" item this plan enables |
| client detail shell | `apps/web/src/app/(admin)/clients/[id]/layout.tsx` | tab list this plan adds a "Tasks" entry to; tabs are route segments under `/clients/[id]/…` |
| new-client dialog | `apps/web/src/app/(admin)/clients/new-client-dialog.tsx` + `apps/web/src/app/(admin)/clients/actions.ts` | this plan adds a package `<select>` and a `packageId` field |
| web enqueue | `apps/web/src/lib/queue.ts` | `enqueue(event)` sending pg-boss jobs from the web process |

If Plan 2 filed one of these at a different path, fix the **import path only** — the names and shapes above are fixed by the spec and this plan depends on them exactly.

---

## File structure for this plan

```
packages/db/src/schema/packages.ts                packages, task_templates, PackageIncludes
packages/db/src/schema/tasks.ts                   tasks, task_comments, task enums, ChecklistItem
packages/db/src/schema/clients.ts                 MODIFIED: package_id FK, onboarded_at, handover_at
packages/db/src/schema/index.ts                   MODIFIED: export the two new modules
packages/db/drizzle/0004_*.sql                    generated migration
packages/db/src/seed.ts                           MODIFIED: packages, templates, client packages, tasks

packages/core/src/packages/create-package.ts      createPackage
packages/core/src/packages/update-package.ts      updatePackage
packages/core/src/packages/list-packages.ts       listPackages, getPackage
packages/core/src/packages/create-task-template.ts    createTaskTemplate
packages/core/src/packages/update-task-template.ts    updateTaskTemplate, deleteTaskTemplate
packages/core/src/packages/list-task-templates.ts     listTaskTemplates

packages/core/src/tasks/dates.ts                  addDays, periodBounds, dueWithinPeriod, londonDateKey
packages/core/src/tasks/assignee.ts               pickLeastLoadedStaff, findOwnerUserId
packages/core/src/tasks/create-task.ts            createTask
packages/core/src/tasks/list-tasks.ts             listTasks, TaskFilters
packages/core/src/tasks/get-task.ts               getTask
packages/core/src/tasks/update-task-status.ts     updateTaskStatus
packages/core/src/tasks/assign-task.ts            assignTask
packages/core/src/tasks/comment-on-task.ts        commentOnTask
packages/core/src/tasks/toggle-checklist-item.ts  toggleChecklistItem, setTaskVisibility
packages/core/src/tasks/generate-onboarding-tasks.ts  generateOnboardingTasks
packages/core/src/tasks/generate-recurring-tasks.ts   generateRecurringTasks, quantityFor
packages/core/src/tasks/find-overdue-tasks.ts     findOverdueTasks, notifyOverdueTasks
packages/core/src/tasks/test-fixtures.ts          seedOrgWithClient (tests only)
packages/core/src/events/emit.ts                  MODIFIED: task.created/completed/overdue
packages/core/src/index.ts                        MODIFIED: barrel exports

apps/worker/src/boss.ts                           MODIFIED: three new queue names
apps/worker/src/index.ts                          MODIFIED: client.created mapping, workers, crons
apps/worker/src/jobs/task-generation.ts           handleGenerateOnboarding, runRecurringSweep, runOverdueSweep
apps/worker/src/jobs/task-generation.test.ts

apps/web/src/lib/queue.ts                         MODIFIED: client.created branch
apps/web/src/app/(admin)/layout.tsx               MODIFIED: enable Tasks nav item
apps/web/src/app/(admin)/page.tsx                 MODIFIED: three task dashboard cards
apps/web/src/app/(admin)/tasks/page.tsx           list + board
apps/web/src/app/(admin)/tasks/actions.ts         server actions
apps/web/src/app/(admin)/tasks/task-filters.tsx   GET form
apps/web/src/app/(admin)/tasks/task-board.tsx     status columns
apps/web/src/app/(admin)/tasks/new-task-dialog.tsx
apps/web/src/app/(admin)/tasks/[id]/page.tsx      task detail
apps/web/src/app/(admin)/clients/[id]/tasks/page.tsx   client Tasks tab
apps/web/src/app/(admin)/clients/[id]/layout.tsx  MODIFIED: add the Tasks tab
apps/web/src/app/(admin)/clients/new-client-dialog.tsx  MODIFIED: package select
apps/web/src/app/(admin)/clients/actions.ts       MODIFIED: packageId field
apps/web/src/app/(admin)/settings/packages/page.tsx + actions.ts
apps/web/src/app/(admin)/settings/task-templates/page.tsx + actions.ts
apps/web/src/components/progress-bar.tsx          phase progress
apps/web/tests/e2e/admin-tasks.spec.ts            Playwright smoke

docs/MODULE_MAP.md, docs/DATA_MODEL.md, docs/ARCHITECTURE.md, README.md   MODIFIED
```

---

### Task 1: Schema — packages, task templates, tasks, comments, migration 0004

**Files:**
- Create: `packages/db/src/schema/packages.ts`, `packages/db/src/schema/tasks.ts`, `packages/db/src/schema/tasks.test.ts`
- Modify: `packages/db/src/schema/clients.ts`, `packages/db/src/schema/index.ts`
- Create: `packages/db/drizzle/0004_*.sql` (generated)

**Interfaces:**
- Produces: tables `packages`, `taskTemplates`, `tasks`, `taskComments`; enums `taskPhaseEnum`, `taskKindEnum`, `taskStatusEnum`, `taskPriorityEnum`, `taskRecurrenceEnum`, `taskAssigneeRoleEnum`; types `PackageIncludes`, `ChecklistItem`, `TaskPhase`, `TaskKind`, `TaskStatus`, `TaskPriority`, `TaskRecurrence`, `TaskAssigneeRole`; constant `PACKAGE_INCLUDES_DEFAULT`. `clients.packageId` gains a FK to `packages.id`; `clients.onboardedAt`, `clients.handoverAt` added.
- Consumes: `tenantColumns()` from `_shared.js`, `clients`, `sites`, `actorKindEnum` and `tickets` from `support.js`, `user` from `auth.js`.

- [ ] **Step 1: Write the failing schema test**

`packages/db/src/schema/tasks.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "../test/db.js";
import { clients, organisations, packages, taskComments, taskTemplates, tasks } from "./index.js";

describe("task schema", () => {
  it("links package to template to task to comment and enforces both idempotency keys", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const [pkg] = await db.insert(packages).values({
        organisationId: org!.id,
        name: "Website Care",
        slug: `care-${crypto.randomUUID()}`,
        monthlyPricePence: 9900,
        includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
      }).returning();
      const [client] = await db.insert(clients).values({ organisationId: org!.id, name: "Grays CabLine", packageId: pkg!.id }).returning();
      expect(client!.onboardedAt).toBeNull();
      expect(client!.handoverAt).toBeNull();

      const [template] = await db.insert(taskTemplates).values({
        organisationId: org!.id, packageId: pkg!.id, phase: "onboarding", kind: "build",
        title: "Build website", offsetDays: 14, sortOrder: 40, checklist: ["Homepage", "Contact form"],
      }).returning();
      expect(template!.recurrence).toBe("none");
      expect(template!.defaultAssigneeRole).toBe("any");

      const [task] = await db.insert(tasks).values({
        organisationId: org!.id, clientId: client!.id, templateId: template!.id, phase: "onboarding",
        kind: "build", title: "Build website", checklist: [{ label: "Homepage", done: false }],
      }).returning();
      expect(task!.status).toBe("todo");
      expect(task!.priority).toBe("medium");
      expect(task!.clientVisible).toBe(true);
      expect(task!.completedAt).toBeNull();

      const [comment] = await db.insert(taskComments).values({
        organisationId: org!.id, taskId: task!.id, authorKind: "user", bodyMd: "Started today",
      }).returning();
      expect(comment!.taskId).toBe(task!.id);

      // A second onboarding task for the same (client, template) is rejected.
      await expect(
        db.insert(tasks).values({ organisationId: org!.id, clientId: client!.id, templateId: template!.id, phase: "onboarding", kind: "build", title: "Build website again" }),
      ).rejects.toThrow();

      // recurrence_key is unique per client.
      await db.insert(tasks).values({ organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "social", title: "Social post 1/4", recurrenceKey: "social:2026-10:1" });
      await expect(
        db.insert(tasks).values({ organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "social", title: "dup", recurrenceKey: "social:2026-10:1" }),
      ).rejects.toThrow();

      const rows = await db.select().from(tasks).where(eq(tasks.clientId, client!.id));
      expect(rows).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @launchos/db test`
Expected: FAIL — `packages`, `taskTemplates`, `tasks` and `taskComments` are not exported from `./index.js`.

- [ ] **Step 3: `packages/db/src/schema/packages.ts`**

```ts
import { boolean, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

/**
 * What a retainer buys each month. Quantities drive recurring task generation
 * (4 social posts a month gives 4 tasks); booleans gate whole template families.
 * Keys are camelCase because this is a TypeScript-shaped jsonb payload rather
 * than a column set; the spec's snake_case names map one to one.
 */
export type PackageIncludes = {
  website: boolean;
  seo: boolean;
  ads: boolean;
  socialPostsPerMonth: number;
  blogPostsPerMonth: number;
  gbpUpdatesPerMonth: number;
};

export const PACKAGE_INCLUDES_DEFAULT: PackageIncludes = {
  website: false, seo: false, ads: false,
  socialPostsPerMonth: 0, blogPostsPerMonth: 0, gbpUpdatesPerMonth: 0,
};

export const packages = pgTable("packages", {
  ...tenantColumns(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  monthlyPricePence: integer("monthly_price_pence").default(0).notNull(),
  setupPricePence: integer("setup_price_pence").default(0).notNull(),
  currency: text("currency").default("GBP").notNull(),
  includes: jsonb("includes").$type<PackageIncludes>().default(PACKAGE_INCLUDES_DEFAULT).notNull(),
  active: boolean("active").default(true).notNull(),
}, (t) => [uniqueIndex("packages_org_slug").on(t.organisationId, t.slug)]);

export const taskPhaseEnum = pgEnum("task_phase", ["onboarding", "recurring", "support"]);
export const taskKindEnum = pgEnum("task_kind", [
  "build", "deploy", "dns", "seo", "content", "social", "gbp", "review", "handover", "support", "billing", "other",
]);
export const taskRecurrenceEnum = pgEnum("task_recurrence", ["none", "weekly", "monthly", "quarterly"]);
export const taskAssigneeRoleEnum = pgEnum("task_assignee_role", ["owner", "staff", "any"]);

export type TaskPhase = (typeof taskPhaseEnum.enumValues)[number];
export type TaskKind = (typeof taskKindEnum.enumValues)[number];
export type TaskRecurrence = (typeof taskRecurrenceEnum.enumValues)[number];
export type TaskAssigneeRole = (typeof taskAssigneeRoleEnum.enumValues)[number];

/**
 * A blueprint row. `package_id` null means "applies to every package".
 * Onboarding templates use `offset_days` (due = client.created_at + offset);
 * recurring templates use `recurrence` and take their quantity from the
 * package's `includes`.
 */
export const taskTemplates = pgTable("task_templates", {
  ...tenantColumns(),
  packageId: uuid("package_id").references(() => packages.id, { onDelete: "cascade" }),
  phase: taskPhaseEnum("phase").notNull(),
  kind: taskKindEnum("kind").default("other").notNull(),
  title: text("title").notNull(),
  descriptionMd: text("description_md"),
  offsetDays: integer("offset_days").default(0).notNull(),
  recurrence: taskRecurrenceEnum("recurrence").default("none").notNull(),
  defaultAssigneeRole: taskAssigneeRoleEnum("default_assignee_role").default("any").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  checklist: jsonb("checklist").$type<string[]>().default([]).notNull(),
});
```

- [ ] **Step 4: `packages/db/src/schema/tasks.ts`**

```ts
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { taskKindEnum, taskPhaseEnum, taskTemplates } from "./packages.js";
import { sites } from "./sites.js";
import { actorKindEnum, tickets } from "./support.js";

export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "blocked", "review", "done", "cancelled"]);
export const taskPriorityEnum = pgEnum("task_priority", ["low", "medium", "high", "urgent"]);

export type TaskStatus = (typeof taskStatusEnum.enumValues)[number];
export type TaskPriority = (typeof taskPriorityEnum.enumValues)[number];

/** One line of a task's checklist. Stored as jsonb so a task stays one row. */
export type ChecklistItem = { label: string; done: boolean };

export const tasks = pgTable("tasks", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  templateId: uuid("template_id").references(() => taskTemplates.id, { onDelete: "set null" }),
  phase: taskPhaseEnum("phase").notNull(),
  kind: taskKindEnum("kind").default("other").notNull(),
  title: text("title").notNull(),
  descriptionMd: text("description_md"),
  status: taskStatusEnum("status").default("todo").notNull(),
  priority: taskPriorityEnum("priority").default("medium").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  assigneeUserId: text("assignee_user_id").references(() => user.id, { onDelete: "set null" }),
  createdByKind: actorKindEnum("created_by_kind").default("system").notNull(),
  createdById: text("created_by_id"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  recurrenceKey: text("recurrence_key"),
  checklist: jsonb("checklist").$type<ChecklistItem[]>().default([]).notNull(),
  clientVisible: boolean("client_visible").default(true).notNull(),
}, (t) => [
  // Onboarding generation is idempotent by (client, template): re-running the
  // job after a package change tops up what is missing instead of duplicating.
  uniqueIndex("tasks_client_template_onboarding")
    .on(t.clientId, t.templateId)
    .where(sql`${t.templateId} is not null and ${t.phase} = 'onboarding'`),
  // Recurring generation is idempotent by (client, recurrence_key). NULLs are
  // distinct in Postgres, so non-recurring tasks are unaffected.
  uniqueIndex("tasks_client_recurrence_key").on(t.clientId, t.recurrenceKey),
  index("tasks_org_status_due").on(t.organisationId, t.status, t.dueAt),
  index("tasks_org_client_phase").on(t.organisationId, t.clientId, t.phase),
]);

export const taskComments = pgTable("task_comments", {
  ...tenantColumns(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  authorKind: actorKindEnum("author_kind").notNull(),
  authorId: text("author_id"),
  bodyMd: text("body_md").notNull(),
}, (t) => [index("task_comments_task_created").on(t.taskId, t.createdAt)]);
```

- [ ] **Step 5: Modify `packages/db/src/schema/clients.ts`**

Add `timestamp` to the `drizzle-orm/pg-core` import, add `import { packages } from "./packages.js";`, then replace Plan 2's plain column line `packageId: uuid("package_id"),` inside `clients` with:
```ts
  packageId: uuid("package_id").references(() => packages.id, { onDelete: "set null" }),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  handoverAt: timestamp("handover_at", { withTimezone: true }),
```
`packages.ts` imports only `_shared.js`, so `clients.ts` importing it adds no cycle.

- [ ] **Step 6: Export from `packages/db/src/schema/index.ts`**

Add these two lines after the existing `export * from "./clients.js";` so `packages.ts` is evaluated before `tasks.ts`:
```ts
export * from "./packages.js";
export * from "./tasks.js";
```

- [ ] **Step 7: Generate and apply migration 0004**

Run: `pnpm db:generate`
Expected: `packages/db/drizzle/0004_*.sql` creating enums `task_phase`, `task_kind`, `task_recurrence`, `task_assignee_role`, `task_status`, `task_priority`; tables `packages`, `task_templates`, `tasks`, `task_comments`; the four indexes; `ALTER TABLE "clients" ADD COLUMN "onboarded_at"` and `"handover_at"`; and `ALTER TABLE "clients" ADD CONSTRAINT "clients_package_id_packages_id_fk"`.

Read the SQL before applying. If drizzle-kit prompts about `clients.package_id`, choose the option that keeps the existing column rather than dropping and recreating it.

Run: `pnpm db:up && pnpm db:migrate`
Expected: migration applied with no error.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @launchos/db test`
Expected: PASS — both duplicate inserts reject on the unique indexes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(db): packages, task templates, tasks and task comments with idempotency indexes (migration 0004)"
```

---

### Task 2: Core — packages and task template CRUD

**Files:**
- Create: `packages/core/src/packages/create-package.ts`, `update-package.ts`, `list-packages.ts`, `create-task-template.ts`, `update-task-template.ts`, `list-task-templates.ts`, `packages.test.ts`, `task-templates.test.ts`
- Create: `packages/core/src/tasks/test-fixtures.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `createPackage(db, organisationId, { name, slug, description?, monthlyPricePence?, setupPricePence?, currency?, includes?, active?, actorKind?, actorId? })` → package row
  - `updatePackage(db, organisationId, { packageId, name?, description?, monthlyPricePence?, setupPricePence?, includes?, active?, actorKind?, actorId? })` → package row
  - `listPackages(db, organisationId, { activeOnly? })` → package rows ordered by `name`
  - `getPackage(db, organisationId, packageId)` → package row or `null`
  - `createTaskTemplate(db, organisationId, { packageId?, phase, kind, title, descriptionMd?, offsetDays?, recurrence?, defaultAssigneeRole?, sortOrder?, checklist?, actorKind?, actorId? })` → template row
  - `updateTaskTemplate(db, organisationId, { templateId, ...same optional fields })` → template row
  - `deleteTaskTemplate(db, organisationId, { templateId, actorKind?, actorId? })` → `{ deleted: boolean }`
  - `listTaskTemplates(db, organisationId, { phase?, packageId?, includeGlobal? })` → template rows ordered by `sortOrder` then `createdAt`
  - `seedOrgWithClient(db)` (tests only) → `{ organisationId, ownerUserId, clientId, packageId }`
- Consumes: `recordAudit`, `assertOwned` (Plan 2), `schema.packages`, `schema.taskTemplates`, `schema.clients`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/tasks/test-fixtures.ts` (imported only by tests; it has no runtime dependants):
```ts
import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";

/**
 * The smallest world a task test needs: an organisation, an owner user and
 * member row, a package and a client already on that package.
 */
export async function seedOrgWithClient(db: Db) {
  const [organisation] = await db.insert(schema.organisations)
    .values({ name: "Test Org", slug: `org-${randomUUID()}` }).returning();
  const [ownerUser] = await db.insert(schema.user)
    .values({ id: randomUUID(), name: "Owner", email: `owner-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.organisationMembers)
    .values({ organisationId: organisation!.id, userId: ownerUser!.id, role: "owner", status: "active" });
  const [pkg] = await db.insert(schema.packages).values({
    organisationId: organisation!.id, name: "Website + SEO + Social", slug: `pkg-${randomUUID()}`,
    includes: { website: true, seo: true, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
  }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: organisation!.id, name: "Grays CabLine", slug: `client-${randomUUID()}`, packageId: pkg!.id,
  }).returning();
  return { organisationId: organisation!.id, ownerUserId: ownerUser!.id, clientId: client!.id, packageId: pkg!.id };
}

/** A second active staff member, for assignment tests. */
export async function addStaffMember(db: Db, organisationId: string, displayName = "Staff") {
  const [staff] = await db.insert(schema.user)
    .values({ id: randomUUID(), name: displayName, email: `staff-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.organisationMembers)
    .values({ organisationId, userId: staff!.id, role: "staff", status: "active", displayName });
  return staff!.id;
}
```

`packages/core/src/packages/packages.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { createPackage } from "./create-package.js";
import { updatePackage } from "./update-package.js";
import { getPackage, listPackages } from "./list-packages.js";

describe("packages", () => {
  it("creates, lists, updates and archives a package and audits every write", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const created = await createPackage(db, organisationId, {
        name: "Website Care", slug: `care-${randomUUID()}`, monthlyPricePence: 9900,
        includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
      });
      expect(created.currency).toBe("GBP");
      expect(created.includes.blogPostsPerMonth).toBe(1);

      const updated = await updatePackage(db, organisationId, { packageId: created.id, monthlyPricePence: 12900 });
      expect(updated.monthlyPricePence).toBe(12900);

      expect((await listPackages(db, organisationId, { activeOnly: true })).map((p) => p.id)).toContain(created.id);
      await updatePackage(db, organisationId, { packageId: created.id, active: false });
      expect((await listPackages(db, organisationId, { activeOnly: true })).map((p) => p.id)).not.toContain(created.id);
      expect((await getPackage(db, organisationId, created.id))?.active).toBe(false);

      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, created.id));
      expect(audits.map((a) => a.action)).toEqual(["package.created", "package.updated", "package.updated"]);
    });
  });

  it("refuses a package from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await expect(updatePackage(db, b.organisationId, { packageId: a.packageId, active: false })).rejects.toThrow();
      expect(await getPackage(db, b.organisationId, a.packageId)).toBeNull();
    });
  });
});
```

`packages/core/src/packages/task-templates.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { createTaskTemplate } from "./create-task-template.js";
import { deleteTaskTemplate, updateTaskTemplate } from "./update-task-template.js";
import { listTaskTemplates } from "./list-task-templates.js";

describe("task templates", () => {
  it("orders by sort_order, filters by phase and package, and includes global templates", async () => {
    await withTestDb(async (db) => {
      const { organisationId, packageId } = await seedOrgWithClient(db);
      const global = await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "build", title: "Build website", offsetDays: 14, sortOrder: 20 });
      const scoped = await createTaskTemplate(db, organisationId, { packageId, phase: "onboarding", kind: "seo", title: "SEO setup", offsetDays: 20, sortOrder: 10 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "social", title: "Social post", recurrence: "monthly" });

      const onboarding = await listTaskTemplates(db, organisationId, { phase: "onboarding", packageId, includeGlobal: true });
      expect(onboarding.map((t) => t.id)).toEqual([scoped.id, global.id]);

      const scopedOnly = await listTaskTemplates(db, organisationId, { phase: "onboarding", packageId, includeGlobal: false });
      expect(scopedOnly.map((t) => t.id)).toEqual([scoped.id]);

      const renamed = await updateTaskTemplate(db, organisationId, { templateId: global.id, title: "Build the website", sortOrder: 5 });
      expect(renamed.title).toBe("Build the website");
      expect(renamed.sortOrder).toBe(5);

      expect(await deleteTaskTemplate(db, organisationId, { templateId: global.id })).toEqual({ deleted: true });
      expect((await listTaskTemplates(db, organisationId, { phase: "onboarding", packageId, includeGlobal: true })).map((t) => t.id)).toEqual([scoped.id]);
    });
  });

  it("refuses a template from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const t = await createTaskTemplate(db, a.organisationId, { phase: "onboarding", kind: "build", title: "Build" });
      await expect(updateTaskTemplate(db, b.organisationId, { templateId: t.id, title: "Hijack" })).rejects.toThrow();
      expect(await deleteTaskTemplate(db, b.organisationId, { templateId: t.id })).toEqual({ deleted: false });
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./create-package.js`, `./update-package.js`, `./list-packages.js`, `./create-task-template.js`, `./update-task-template.js`, `./list-task-templates.js` and `../tasks/test-fixtures.js` cannot be resolved.

- [ ] **Step 3: `packages/core/src/packages/create-package.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const PackageIncludesInput = z.object({
  website: z.boolean().default(false),
  seo: z.boolean().default(false),
  ads: z.boolean().default(false),
  socialPostsPerMonth: z.number().int().min(0).max(60).default(0),
  blogPostsPerMonth: z.number().int().min(0).max(60).default(0),
  gbpUpdatesPerMonth: z.number().int().min(0).max(60).default(0),
});

export const CreatePackageInput = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, digits and hyphens"),
  description: z.string().max(2000).optional(),
  monthlyPricePence: z.number().int().min(0).default(0),
  setupPricePence: z.number().int().min(0).default(0),
  currency: z.string().length(3).default("GBP"),
  includes: PackageIncludesInput.default({}),
  active: z.boolean().default(true),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type CreatePackageInput = z.input<typeof CreatePackageInput>;

export async function createPackage(db: Db, organisationId: string, input: CreatePackageInput) {
  const v = CreatePackageInput.parse(input);
  const [pkg] = await db.insert(schema.packages).values({
    organisationId, name: v.name, slug: v.slug, description: v.description ?? null,
    monthlyPricePence: v.monthlyPricePence, setupPricePence: v.setupPricePence,
    currency: v.currency, includes: v.includes, active: v.active,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "package.created",
    targetType: "package", targetId: pkg!.id, after: pkg,
  });
  return pkg!;
}
```

- [ ] **Step 4: `packages/core/src/packages/update-package.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { PackageIncludesInput } from "./create-package.js";

export const UpdatePackageInput = z.object({
  packageId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullish(),
  monthlyPricePence: z.number().int().min(0).optional(),
  setupPricePence: z.number().int().min(0).optional(),
  includes: PackageIncludesInput.optional(),
  active: z.boolean().optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type UpdatePackageInput = z.input<typeof UpdatePackageInput>;

export async function updatePackage(db: Db, organisationId: string, input: UpdatePackageInput) {
  const v = UpdatePackageInput.parse(input);
  const where = and(eq(schema.packages.id, v.packageId), eq(schema.packages.organisationId, organisationId));
  const [before] = await db.select().from(schema.packages).where(where);
  if (!before) throw new Error(`package ${v.packageId} not found in organisation`);

  // Immutable update: build the patch, never mutate `before`.
  const [after] = await db.update(schema.packages).set({
    ...(v.name === undefined ? {} : { name: v.name }),
    ...(v.description === undefined ? {} : { description: v.description ?? null }),
    ...(v.monthlyPricePence === undefined ? {} : { monthlyPricePence: v.monthlyPricePence }),
    ...(v.setupPricePence === undefined ? {} : { setupPricePence: v.setupPricePence }),
    ...(v.includes === undefined ? {} : { includes: v.includes }),
    ...(v.active === undefined ? {} : { active: v.active }),
    updatedAt: new Date(),
  }).where(where).returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "package.updated",
    targetType: "package", targetId: v.packageId, before, after,
  });
  return after!;
}
```

- [ ] **Step 5: `packages/core/src/packages/list-packages.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

export const ListPackagesInput = z.object({ activeOnly: z.boolean().default(false) });
export type ListPackagesInput = z.input<typeof ListPackagesInput>;

export async function listPackages(db: Db, organisationId: string, input: ListPackagesInput = {}) {
  const v = ListPackagesInput.parse(input);
  const where = v.activeOnly
    ? and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.active, true))
    : eq(schema.packages.organisationId, organisationId);
  return db.select().from(schema.packages).where(where).orderBy(asc(schema.packages.name));
}

export async function getPackage(db: Db, organisationId: string, packageId: string) {
  const [row] = await db.select().from(schema.packages)
    .where(and(eq(schema.packages.id, packageId), eq(schema.packages.organisationId, organisationId)));
  return row ?? null;
}
```

- [ ] **Step 6: `packages/core/src/packages/create-task-template.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const TaskTemplateFields = z.object({
  packageId: z.string().uuid().nullish(),
  phase: z.enum(schema.taskPhaseEnum.enumValues),
  kind: z.enum(schema.taskKindEnum.enumValues).default("other"),
  title: z.string().min(1).max(200),
  descriptionMd: z.string().max(10000).nullish(),
  offsetDays: z.number().int().min(0).max(365).default(0),
  recurrence: z.enum(schema.taskRecurrenceEnum.enumValues).default("none"),
  defaultAssigneeRole: z.enum(schema.taskAssigneeRoleEnum.enumValues).default("any"),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  checklist: z.array(z.string().min(1).max(200)).max(50).default([]),
});

export const CreateTaskTemplateInput = TaskTemplateFields.extend({
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type CreateTaskTemplateInput = z.input<typeof CreateTaskTemplateInput>;

export async function createTaskTemplate(db: Db, organisationId: string, input: CreateTaskTemplateInput) {
  const v = CreateTaskTemplateInput.parse(input);
  if (v.packageId) await assertOwned(db, organisationId, schema.packages, v.packageId);
  const [template] = await db.insert(schema.taskTemplates).values({
    organisationId, packageId: v.packageId ?? null, phase: v.phase, kind: v.kind, title: v.title,
    descriptionMd: v.descriptionMd ?? null, offsetDays: v.offsetDays, recurrence: v.recurrence,
    defaultAssigneeRole: v.defaultAssigneeRole, sortOrder: v.sortOrder, checklist: v.checklist,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "task_template.created",
    targetType: "task_template", targetId: template!.id, after: template,
  });
  return template!;
}
```

- [ ] **Step 7: `packages/core/src/packages/update-task-template.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { TaskTemplateFields } from "./create-task-template.js";

const Actor = { actorKind: z.enum(["user", "client", "agent", "system"]).default("user"), actorId: z.string().optional() };

export const UpdateTaskTemplateInput = TaskTemplateFields.partial().extend({
  templateId: z.string().uuid(),
  ...Actor,
});
export type UpdateTaskTemplateInput = z.input<typeof UpdateTaskTemplateInput>;

export async function updateTaskTemplate(db: Db, organisationId: string, input: UpdateTaskTemplateInput) {
  const v = UpdateTaskTemplateInput.parse(input);
  const where = and(eq(schema.taskTemplates.id, v.templateId), eq(schema.taskTemplates.organisationId, organisationId));
  const [before] = await db.select().from(schema.taskTemplates).where(where);
  if (!before) throw new Error(`task template ${v.templateId} not found in organisation`);
  if (v.packageId) await assertOwned(db, organisationId, schema.packages, v.packageId);

  const [after] = await db.update(schema.taskTemplates).set({
    ...(v.packageId === undefined ? {} : { packageId: v.packageId ?? null }),
    ...(v.phase === undefined ? {} : { phase: v.phase }),
    ...(v.kind === undefined ? {} : { kind: v.kind }),
    ...(v.title === undefined ? {} : { title: v.title }),
    ...(v.descriptionMd === undefined ? {} : { descriptionMd: v.descriptionMd ?? null }),
    ...(v.offsetDays === undefined ? {} : { offsetDays: v.offsetDays }),
    ...(v.recurrence === undefined ? {} : { recurrence: v.recurrence }),
    ...(v.defaultAssigneeRole === undefined ? {} : { defaultAssigneeRole: v.defaultAssigneeRole }),
    ...(v.sortOrder === undefined ? {} : { sortOrder: v.sortOrder }),
    ...(v.checklist === undefined ? {} : { checklist: v.checklist }),
    updatedAt: new Date(),
  }).where(where).returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "task_template.updated",
    targetType: "task_template", targetId: v.templateId, before, after,
  });
  return after!;
}

export const DeleteTaskTemplateInput = z.object({ templateId: z.string().uuid(), ...Actor });
export type DeleteTaskTemplateInput = z.input<typeof DeleteTaskTemplateInput>;

/**
 * Hard delete. `tasks.template_id` is ON DELETE SET NULL, so tasks already
 * generated from the template survive; they simply stop counting towards the
 * (client, template) idempotency key, which is correct — the blueprint is gone.
 */
export async function deleteTaskTemplate(db: Db, organisationId: string, input: DeleteTaskTemplateInput) {
  const v = DeleteTaskTemplateInput.parse(input);
  const where = and(eq(schema.taskTemplates.id, v.templateId), eq(schema.taskTemplates.organisationId, organisationId));
  const [before] = await db.select().from(schema.taskTemplates).where(where);
  if (!before) return { deleted: false };
  await db.delete(schema.taskTemplates).where(where);
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "task_template.deleted",
    targetType: "task_template", targetId: v.templateId, before,
  });
  return { deleted: true };
}
```

- [ ] **Step 8: `packages/core/src/packages/list-task-templates.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";

export const ListTaskTemplatesInput = z.object({
  phase: z.enum(schema.taskPhaseEnum.enumValues).optional(),
  packageId: z.string().uuid().optional(),
  /** true: also return templates with a null package_id (apply to everything). */
  includeGlobal: z.boolean().default(true),
});
export type ListTaskTemplatesInput = z.input<typeof ListTaskTemplatesInput>;

export async function listTaskTemplates(db: Db, organisationId: string, input: ListTaskTemplatesInput = {}) {
  const v = ListTaskTemplatesInput.parse(input);
  const where: SQL[] = [eq(schema.taskTemplates.organisationId, organisationId)];
  if (v.phase) where.push(eq(schema.taskTemplates.phase, v.phase));
  if (v.packageId) {
    where.push(
      v.includeGlobal
        ? or(isNull(schema.taskTemplates.packageId), eq(schema.taskTemplates.packageId, v.packageId))!
        : eq(schema.taskTemplates.packageId, v.packageId),
    );
  } else if (!v.includeGlobal) {
    where.push(isNull(schema.taskTemplates.packageId));
  }
  return db.select().from(schema.taskTemplates)
    .where(and(...where))
    .orderBy(asc(schema.taskTemplates.sortOrder), asc(schema.taskTemplates.createdAt));
}
```

- [ ] **Step 9: Barrel exports**

Append to `packages/core/src/index.ts`:
```ts
export { createPackage, CreatePackageInput, PackageIncludesInput } from "./packages/create-package.js";
export { updatePackage, UpdatePackageInput } from "./packages/update-package.js";
export { getPackage, listPackages, ListPackagesInput } from "./packages/list-packages.js";
export { createTaskTemplate, CreateTaskTemplateInput, TaskTemplateFields } from "./packages/create-task-template.js";
export { deleteTaskTemplate, updateTaskTemplate, DeleteTaskTemplateInput, UpdateTaskTemplateInput } from "./packages/update-task-template.js";
export { listTaskTemplates, ListTaskTemplatesInput } from "./packages/list-task-templates.js";
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS for both test files; typecheck clean.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(core): packages and task template CRUD with tenancy assertions and audit"
```

---

### Task 3: Core — date helpers, domain events, createTask, listTasks, getTask

**Files:**
- Create: `packages/core/src/tasks/dates.ts`, `dates.test.ts`, `create-task.ts`, `list-tasks.ts`, `get-task.ts`, `create-task.test.ts`, `list-tasks.test.ts`
- Modify: `packages/core/src/events/emit.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `addDays(date: Date, days: number): Date`
  - `periodBounds(recurrence: TaskRecurrence, now: Date): { key: string; start: Date; end: Date }`
  - `dueWithinPeriod(period, n: number, quantity: number): Date`
  - `londonDateKey(date: Date): string` — `YYYY-MM-DD` in Europe/London
  - `createTask(db, organisationId, { clientId, siteId?, title, kind, phase, priority?, dueAt?, assigneeUserId?, ticketId?, descriptionMd?, clientVisible?, templateId?, recurrenceKey?, checklist?, status?, actorKind?, actorId? })` → task row
  - `listTasks(db, organisationId, filters)` → `TaskListRow[]`; `TaskFilters` = `{ clientId?, siteId?, status?: TaskStatus[], assigneeUserId?: string | "unassigned", phase?, kind?, dueFrom?, dueTo?, clientVisible?, limit?, offset? }`
  - `getTask(db, organisationId, taskId)` → `{ task, comments } | null`
  - `DomainEvent` gains `task.created`, `task.completed`, `task.overdue`, each `{ organisationId, taskId }`
- Consumes: `recordAudit`, `recordActivity` (Plan 2), `emit`, `assertClientInOrganisation`, `assertSiteInOrganisation`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/tasks/dates.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { addDays, dueWithinPeriod, londonDateKey, periodBounds } from "./dates.js";

describe("task dates", () => {
  it("adds whole days without mutating the input", () => {
    const base = new Date("2026-10-01T09:00:00.000Z");
    expect(addDays(base, 14).toISOString()).toBe("2026-10-15T09:00:00.000Z");
    expect(base.toISOString()).toBe("2026-10-01T09:00:00.000Z");
  });

  it("bounds monthly, quarterly and weekly periods", () => {
    const now = new Date("2026-10-14T12:00:00.000Z"); // a Wednesday
    expect(periodBounds("monthly", now).key).toBe("2026-10");
    expect(periodBounds("monthly", now).start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodBounds("monthly", now).end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(periodBounds("quarterly", now).key).toBe("2026-Q4");
    expect(periodBounds("weekly", now).key).toBe("2026-W-2026-10-12");
    expect(periodBounds("none", now).key).toBe("2026-10");
  });

  it("spreads n tasks evenly inside the period", () => {
    const p = periodBounds("monthly", new Date("2026-10-14T12:00:00.000Z"));
    const dues = [1, 2, 3, 4].map((n) => dueWithinPeriod(p, n, 4).toISOString().slice(0, 10));
    expect(dues).toEqual(["2026-10-07", "2026-10-13", "2026-10-19", "2026-10-25"]);
    expect(dueWithinPeriod(p, 1, 1).toISOString().slice(0, 10)).toBe("2026-10-16");
  });

  it("formats a London date key", () => {
    // 00:30 UTC on 1 July is 01:30 British Summer Time, still the 1st.
    expect(londonDateKey(new Date("2026-07-01T00:30:00.000Z"))).toBe("2026-07-01");
    // 23:30 UTC on 30 June is 00:30 BST on 1 July.
    expect(londonDateKey(new Date("2026-06-30T23:30:00.000Z"))).toBe("2026-07-01");
  });
});
```

`packages/core/src/tasks/create-task.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { getTask } from "./get-task.js";

describe("createTask", () => {
  it("writes the task, audits it, records activity and emits task.created", async () => {
    await withTestDb(async (db) => {
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const { organisationId, clientId } = await seedOrgWithClient(db);

      const task = await createTask(db, organisationId, {
        clientId, title: "Build website", kind: "build", phase: "onboarding",
        dueAt: new Date("2026-10-15T09:00:00.000Z"), descriptionMd: "Ship the marketing site",
        checklist: [{ label: "Homepage" }, { label: "Contact form" }],
        actorKind: "user", actorId: "user-1",
      });

      expect(task.status).toBe("todo");
      expect(task.priority).toBe("medium");
      expect(task.clientVisible).toBe(true);
      expect(task.checklist).toEqual([{ label: "Homepage", done: false }, { label: "Contact form", done: false }]);
      expect(task.createdByKind).toBe("user");

      const loaded = await getTask(db, organisationId, task.id);
      expect(loaded?.task.title).toBe("Build website");
      expect(loaded?.comments).toEqual([]);

      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, task.id));
      expect(audits.map((a) => a.action)).toEqual(["task.created"]);
      expect(events).toEqual([{ name: "task.created", organisationId, taskId: task.id }]);

      setEnqueue(async () => {});
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await expect(
        createTask(db, b.organisationId, { clientId: a.clientId, title: "X", kind: "other", phase: "support" }),
      ).rejects.toThrow(/not found in organisation/);
      expect(await getTask(db, b.organisationId, a.clientId)).toBeNull();
    });
  });
});
```

`packages/core/src/tasks/list-tasks.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { addStaffMember, seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { listTasks } from "./list-tasks.js";

describe("listTasks", () => {
  it("filters by client, status, phase, kind, assignee and due range", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const staffId = await addStaffMember(db, organisationId, "Aaliyan");

      const early = await createTask(db, organisationId, { clientId, title: "Discovery call", kind: "other", phase: "onboarding", dueAt: new Date("2026-10-02T09:00:00.000Z"), assigneeUserId: staffId });
      const late = await createTask(db, organisationId, { clientId, title: "Social post 1/4", kind: "social", phase: "recurring", dueAt: new Date("2026-10-25T09:00:00.000Z"), clientVisible: false });
      await createTask(db, organisationId, { clientId, title: "No due date", kind: "other", phase: "support" });

      expect((await listTasks(db, organisationId, { clientId })).map((t) => t.id)).toEqual([early.id, late.id, expect.any(String)]);
      expect((await listTasks(db, organisationId, { phase: "recurring" })).map((t) => t.id)).toEqual([late.id]);
      expect((await listTasks(db, organisationId, { kind: "social" })).map((t) => t.id)).toEqual([late.id]);
      expect((await listTasks(db, organisationId, { assigneeUserId: staffId })).map((t) => t.id)).toEqual([early.id]);
      expect((await listTasks(db, organisationId, { assigneeUserId: "unassigned" })).map((t) => t.id)).toContain(late.id);
      expect((await listTasks(db, organisationId, { status: ["todo"] })).length).toBe(3);
      expect((await listTasks(db, organisationId, { status: ["done"] })).length).toBe(0);
      expect((await listTasks(db, organisationId, { clientVisible: true })).map((t) => t.id)).not.toContain(late.id);
      expect((await listTasks(db, organisationId, {
        dueFrom: new Date("2026-10-20T00:00:00.000Z"), dueTo: new Date("2026-10-31T00:00:00.000Z"),
      })).map((t) => t.id)).toEqual([late.id]);

      const rows = await listTasks(db, organisationId, { clientId, limit: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.clientName).toBe("Grays CabLine");
      expect(rows[0]!.assigneeName).toBe("Aaliyan");
    });
  });

  it("never returns another organisation's tasks", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await createTask(db, a.organisationId, { clientId: a.clientId, title: "Theirs", kind: "other", phase: "support" });
      expect(await listTasks(db, b.organisationId, {})).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./dates.js`, `./create-task.js`, `./get-task.js` and `./list-tasks.js` cannot be resolved.

- [ ] **Step 3: `packages/core/src/tasks/dates.ts`**

```ts
import type { TaskRecurrence } from "@launchos/db/schema";

const DAY_MS = 86_400_000;

/** A new Date `days` later. Never mutates its argument. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export type Period = { key: string; start: Date; end: Date };

/**
 * The period a recurring template falls in right now, as a half-open range
 * [start, end). Bounds are computed in UTC: Europe/London is at most one hour
 * off UTC, which cannot move a day-granularity due date across a period.
 * `none` never reaches generation but is mapped to the month so the function
 * is total.
 */
export function periodBounds(recurrence: TaskRecurrence, now: Date): Period {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  if (recurrence === "quarterly") {
    const quarter = Math.floor(month / 3);
    return {
      key: `${year}-Q${quarter + 1}`,
      start: new Date(Date.UTC(year, quarter * 3, 1)),
      end: new Date(Date.UTC(year, quarter * 3 + 3, 1)),
    };
  }

  if (recurrence === "weekly") {
    // Monday-based week; the key carries the Monday so it sorts and reads well.
    const mondayOffset = (now.getUTCDay() + 6) % 7;
    const start = new Date(Date.UTC(year, month, now.getUTCDate() - mondayOffset));
    return { key: `${year}-W-${start.toISOString().slice(0, 10)}`, start, end: new Date(start.getTime() + 7 * DAY_MS) };
  }

  return {
    key: `${year}-${String(month + 1).padStart(2, "0")}`,
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
}

/**
 * Due date for the nth of `quantity` tasks in a period, spread evenly so four
 * social posts land roughly weekly rather than all on the 1st.
 */
export function dueWithinPeriod(period: Period, n: number, quantity: number): Date {
  const span = period.end.getTime() - period.start.getTime();
  return new Date(period.start.getTime() + Math.round((span * n) / (quantity + 1)));
}

/** `YYYY-MM-DD` in Europe/London — the once-per-day notification key. */
export function londonDateKey(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
```

- [ ] **Step 4: Extend `packages/core/src/events/emit.ts`**

Replace the `DomainEvent` union with:
```ts
export type DomainEvent =
  | { name: "incident.opened"; organisationId: string; incidentId: string }
  | { name: "ticket.created"; organisationId: string; ticketId: string }
  | { name: "client.created"; organisationId: string; clientId: string }
  | { name: "task.created"; organisationId: string; taskId: string }
  | { name: "task.completed"; organisationId: string; taskId: string }
  | { name: "task.overdue"; organisationId: string; taskId: string };
```
The `client.created` member is Plan 2's; keep whatever Plan 2 wrote and add the three `task.*` members.

- [ ] **Step 5: `packages/core/src/tasks/create-task.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { assertClientInOrganisation, assertSiteInOrganisation } from "../tenancy/assert-owned.js";

export const CreateTaskInput = z.object({
  clientId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  kind: z.enum(schema.taskKindEnum.enumValues).default("other"),
  phase: z.enum(schema.taskPhaseEnum.enumValues),
  status: z.enum(schema.taskStatusEnum.enumValues).default("todo"),
  priority: z.enum(schema.taskPriorityEnum.enumValues).default("medium"),
  dueAt: z.coerce.date().optional(),
  assigneeUserId: z.string().optional(),
  ticketId: z.string().uuid().optional(),
  descriptionMd: z.string().max(20000).optional(),
  recurrenceKey: z.string().max(120).optional(),
  checklist: z.array(z.object({ label: z.string().min(1).max(200), done: z.boolean().default(false) })).max(50).default([]),
  clientVisible: z.boolean().default(true),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateTaskInput = z.input<typeof CreateTaskInput>;

export async function createTask(db: Db, organisationId: string, input: CreateTaskInput) {
  const v = CreateTaskInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);
  if (v.siteId) await assertSiteInOrganisation(db, organisationId, v.siteId);

  // One transaction: a task without its audit row or timeline entry is a task
  // nobody can explain later.
  const task = await db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.tasks).values({
      organisationId,
      clientId: v.clientId,
      siteId: v.siteId ?? null,
      templateId: v.templateId ?? null,
      phase: v.phase,
      kind: v.kind,
      title: v.title,
      descriptionMd: v.descriptionMd ?? null,
      status: v.status,
      priority: v.priority,
      dueAt: v.dueAt ?? null,
      assigneeUserId: v.assigneeUserId ?? null,
      ticketId: v.ticketId ?? null,
      recurrenceKey: v.recurrenceKey ?? null,
      checklist: v.checklist,
      clientVisible: v.clientVisible,
      createdByKind: v.actorKind,
      createdById: v.actorId ?? null,
    }).returning();

    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "task.created",
      targetType: "task", targetId: row!.id, after: row,
    });
    await recordActivity(tx as unknown as Db, organisationId, {
      clientId: v.clientId, siteId: v.siteId, actorKind: v.actorKind, actorId: v.actorId,
      kind: "task.created", title: `Task created: ${v.title}`, link: `/tasks/${row!.id}`,
    });
    return row!;
  });

  await emit({ name: "task.created", organisationId, taskId: task.id });
  return task;
}
```

- [ ] **Step 6: `packages/core/src/tasks/list-tasks.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { TaskKind, TaskPhase, TaskPriority, TaskStatus } from "@launchos/db/schema";
import { and, asc, eq, gte, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { z } from "zod";

export const TaskFilters = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  status: z.array(z.enum(schema.taskStatusEnum.enumValues)).min(1).optional(),
  /** A user id, or the literal "unassigned". */
  assigneeUserId: z.string().min(1).optional(),
  phase: z.enum(schema.taskPhaseEnum.enumValues).optional(),
  kind: z.enum(schema.taskKindEnum.enumValues).optional(),
  dueFrom: z.coerce.date().optional(),
  dueTo: z.coerce.date().optional(),
  clientVisible: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});
export type TaskFilters = z.input<typeof TaskFilters>;

export type TaskListRow = {
  id: string;
  title: string;
  phase: TaskPhase;
  kind: TaskKind;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: Date | null;
  completedAt: Date | null;
  clientVisible: boolean;
  clientId: string;
  clientName: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
};

export async function listTasks(db: Db, organisationId: string, filters: TaskFilters = {}): Promise<TaskListRow[]> {
  const f = TaskFilters.parse(filters);
  const where: SQL[] = [eq(schema.tasks.organisationId, organisationId)];
  if (f.clientId) where.push(eq(schema.tasks.clientId, f.clientId));
  if (f.siteId) where.push(eq(schema.tasks.siteId, f.siteId));
  if (f.status) where.push(inArray(schema.tasks.status, f.status));
  if (f.phase) where.push(eq(schema.tasks.phase, f.phase));
  if (f.kind) where.push(eq(schema.tasks.kind, f.kind));
  if (f.assigneeUserId === "unassigned") where.push(isNull(schema.tasks.assigneeUserId));
  else if (f.assigneeUserId) where.push(eq(schema.tasks.assigneeUserId, f.assigneeUserId));
  if (f.dueFrom) where.push(gte(schema.tasks.dueAt, f.dueFrom));
  if (f.dueTo) where.push(lte(schema.tasks.dueAt, f.dueTo));
  if (f.clientVisible !== undefined) where.push(eq(schema.tasks.clientVisible, f.clientVisible));

  return db.select({
    id: schema.tasks.id,
    title: schema.tasks.title,
    phase: schema.tasks.phase,
    kind: schema.tasks.kind,
    status: schema.tasks.status,
    priority: schema.tasks.priority,
    dueAt: schema.tasks.dueAt,
    completedAt: schema.tasks.completedAt,
    clientVisible: schema.tasks.clientVisible,
    clientId: schema.tasks.clientId,
    clientName: schema.clients.name,
    assigneeUserId: schema.tasks.assigneeUserId,
    assigneeName: schema.organisationMembers.displayName,
  })
    .from(schema.tasks)
    .innerJoin(schema.clients, eq(schema.tasks.clientId, schema.clients.id))
    .leftJoin(
      schema.organisationMembers,
      and(
        eq(schema.organisationMembers.userId, schema.tasks.assigneeUserId),
        eq(schema.organisationMembers.organisationId, organisationId),
      ),
    )
    .where(and(...where))
    // Postgres sorts NULLs last on ASC, so undated tasks fall to the bottom.
    .orderBy(asc(schema.tasks.dueAt), asc(schema.tasks.createdAt))
    .limit(f.limit)
    .offset(f.offset);
}
```

- [ ] **Step 7: `packages/core/src/tasks/get-task.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";

/** The task plus its comment thread, or null when it is not this org's task. */
export async function getTask(db: Db, organisationId: string, taskId: string) {
  const [task] = await db.select().from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.organisationId, organisationId)));
  if (!task) return null;
  const comments = await db.select().from(schema.taskComments)
    .where(and(eq(schema.taskComments.taskId, taskId), eq(schema.taskComments.organisationId, organisationId)))
    .orderBy(asc(schema.taskComments.createdAt));
  return { task, comments };
}
```
`getTask` is called with a client id in one test and must return `null` rather than throw, which the `where` clause already guarantees.

- [ ] **Step 8: Barrel exports**

Append to `packages/core/src/index.ts`:
```ts
export { addDays, dueWithinPeriod, londonDateKey, periodBounds } from "./tasks/dates.js";
export type { Period } from "./tasks/dates.js";
export { createTask, CreateTaskInput } from "./tasks/create-task.js";
export { listTasks, TaskFilters } from "./tasks/list-tasks.js";
export type { TaskListRow } from "./tasks/list-tasks.js";
export { getTask } from "./tasks/get-task.js";
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS. If `dueWithinPeriod` day expectations are off by one, read the printed ISO strings and correct the test's expected days — the formula, not the test, is the contract.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(core): task date helpers, task domain events, createTask, listTasks and getTask"
```

---

### Task 4: Core — updateTaskStatus, onboarded_at and handover_at

**Files:**
- Create: `packages/core/src/tasks/update-task-status.ts`, `update-task-status.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `updateTaskStatus(db, organisationId, { taskId, status, actorKind?, actorId? })` → `{ task, onboardingCompleted: boolean, handoverRecorded: boolean }`. Sets `completed_at` when the status becomes `done` and clears it otherwise; stamps `clients.handover_at` the first time a `handover`-kind task is completed; stamps `clients.onboarded_at` the first time no onboarding task for that client is left outside `done`/`cancelled`. Emits `task.completed`.
- Consumes: `recordAudit`, `recordActivity`, `emit`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/tasks/update-task-status.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { updateTaskStatus } from "./update-task-status.js";

async function client(db: Parameters<typeof createTask>[0], clientId: string) {
  const [row] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
  return row!;
}

describe("updateTaskStatus", () => {
  it("stamps completed_at, clears it on reopen, and emits task.completed", async () => {
    await withTestDb(async (db) => {
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const task = await createTask(db, organisationId, { clientId, title: "Social post", kind: "social", phase: "recurring" });

      const done = await updateTaskStatus(db, organisationId, { taskId: task.id, status: "done", actorKind: "user", actorId: "u1" });
      expect(done.task.status).toBe("done");
      expect(done.task.completedAt).toBeInstanceOf(Date);

      const reopened = await updateTaskStatus(db, organisationId, { taskId: task.id, status: "in_progress" });
      expect(reopened.task.completedAt).toBeNull();

      expect(events.filter((e) => e.name === "task.completed")).toEqual([{ name: "task.completed", organisationId, taskId: task.id }]);
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, task.id));
      expect(audits.map((a) => a.action)).toEqual(["task.created", "task.status_changed", "task.status_changed"]);
      setEnqueue(async () => {});
    });
  });

  it("marks the client onboarded only when every onboarding task is finished", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const a = await createTask(db, organisationId, { clientId, title: "Discovery call", kind: "other", phase: "onboarding" });
      const b = await createTask(db, organisationId, { clientId, title: "Handover", kind: "handover", phase: "onboarding" });
      const c = await createTask(db, organisationId, { clientId, title: "Nice to have", kind: "other", phase: "onboarding" });

      const first = await updateTaskStatus(db, organisationId, { taskId: a.id, status: "done" });
      expect(first.onboardingCompleted).toBe(false);
      expect((await client(db, clientId)).onboardedAt).toBeNull();

      const handover = await updateTaskStatus(db, organisationId, { taskId: b.id, status: "done" });
      expect(handover.handoverRecorded).toBe(true);
      expect(handover.onboardingCompleted).toBe(false);
      expect((await client(db, clientId)).handoverAt).toBeInstanceOf(Date);

      // Cancelling clears the task from the outstanding count but does not
      // itself trigger the sweep, so the client is not stamped yet.
      const last = await updateTaskStatus(db, organisationId, { taskId: c.id, status: "cancelled" });
      expect(last.onboardingCompleted).toBe(false);
      expect((await client(db, clientId)).onboardedAt).toBeNull();

      // Completing an already-done task re-runs the check and stamps it.
      const again = await updateTaskStatus(db, organisationId, { taskId: a.id, status: "done" });
      expect(again.onboardingCompleted).toBe(true);
      expect((await client(db, clientId)).onboardedAt).toBeInstanceOf(Date);

      // A recurring task completing later must not re-stamp or throw.
      const r = await createTask(db, organisationId, { clientId, title: "Blog post", kind: "content", phase: "recurring" });
      expect((await updateTaskStatus(db, organisationId, { taskId: r.id, status: "done" })).onboardingCompleted).toBe(false);
    });
  });

  it("refuses a task from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const t = await createTask(db, a.organisationId, { clientId: a.clientId, title: "Theirs", kind: "other", phase: "support" });
      await expect(updateTaskStatus(db, b.organisationId, { taskId: t.id, status: "done" })).rejects.toThrow(/not found in organisation/);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./update-task-status.js` cannot be resolved.

- [ ] **Step 3: `packages/core/src/tasks/update-task-status.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, eq, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";

/** Statuses that mean "no longer on anybody's plate". */
export const FINISHED_STATUSES = ["done", "cancelled"] as const;

export const UpdateTaskStatusInput = z.object({
  taskId: z.string().uuid(),
  status: z.enum(schema.taskStatusEnum.enumValues),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type UpdateTaskStatusInput = z.input<typeof UpdateTaskStatusInput>;

export async function updateTaskStatus(db: Db, organisationId: string, input: UpdateTaskStatusInput) {
  const v = UpdateTaskStatusInput.parse(input);
  const where = and(eq(schema.tasks.id, v.taskId), eq(schema.tasks.organisationId, organisationId));
  const [before] = await db.select().from(schema.tasks).where(where);
  if (!before) throw new Error(`task ${v.taskId} not found in organisation`);

  const result = await db.transaction(async (tx) => {
    const [task] = await tx.update(schema.tasks).set({
      status: v.status,
      // Keep the original completion time when a done task is re-saved as done.
      completedAt: v.status === "done" ? before.completedAt ?? new Date() : null,
      updatedAt: new Date(),
    }).where(where).returning();

    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "task.status_changed",
      targetType: "task", targetId: v.taskId, before, after: task,
    });
    await recordActivity(tx as unknown as Db, organisationId, {
      clientId: task!.clientId, siteId: task!.siteId ?? undefined,
      actorKind: v.actorKind, actorId: v.actorId, kind: "task.status_changed",
      title: `${task!.title}: ${before.status} to ${v.status}`, link: `/tasks/${task!.id}`,
    });

    let handoverRecorded = false;
    let onboardingCompleted = false;

    if (v.status === "done" && task!.kind === "handover") {
      const [c] = await tx.update(schema.clients)
        .set({ handoverAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.clients.id, task!.clientId),
          eq(schema.clients.organisationId, organisationId),
          isNull(schema.clients.handoverAt),
        ))
        .returning();
      handoverRecorded = Boolean(c);
    }

    if (v.status === "done" && task!.phase === "onboarding") {
      const [outstanding] = await tx.select({ value: count() }).from(schema.tasks).where(and(
        eq(schema.tasks.organisationId, organisationId),
        eq(schema.tasks.clientId, task!.clientId),
        eq(schema.tasks.phase, "onboarding"),
        notInArray(schema.tasks.status, [...FINISHED_STATUSES]),
      ));
      if ((outstanding?.value ?? 0) === 0) {
        const [c] = await tx.update(schema.clients)
          .set({ onboardedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(schema.clients.id, task!.clientId),
            eq(schema.clients.organisationId, organisationId),
            isNull(schema.clients.onboardedAt),
          ))
          .returning();
        onboardingCompleted = Boolean(c);
      }
    }

    return { task: task!, onboardingCompleted, handoverRecorded };
  });

  if (v.status === "done") await emit({ name: "task.completed", organisationId, taskId: result.task.id });
  return result;
}
```

The onboarding sweep deliberately runs only when an **onboarding** task is completed: cancelling the last outstanding task leaves the client un-onboarded until a real completion happens, which matches "onboarding complete = all onboarding tasks done" rather than "all tasks stopped".

- [ ] **Step 4: Barrel export**

Append to `packages/core/src/index.ts`:
```ts
export { updateTaskStatus, UpdateTaskStatusInput, FINISHED_STATUSES } from "./tasks/update-task-status.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): task status transitions stamping completed_at, client onboarded_at and handover_at"
```

---

### Task 5: Core — assignment, comments, checklist and client visibility

**Files:**
- Create: `packages/core/src/tasks/assignee.ts`, `assign-task.ts`, `comment-on-task.ts`, `toggle-checklist-item.ts`, `assign-task.test.ts`, `task-detail.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `pickLeastLoadedStaff(db, organisationId)` → `string | null` — the active member with the fewest unfinished tasks, ties broken by oldest membership. **P4's Support Triage `tickets_assign` tool calls this.**
  - `findOwnerUserId(db, organisationId)` → `string | null` — the oldest active `owner` member's user id
  - `assignTask(db, organisationId, { taskId, assigneeUserId, actorKind?, actorId? })` → task row; `assigneeUserId: null` unassigns
  - `commentOnTask(db, organisationId, { taskId, bodyMd, authorKind?, authorId? })` → comment row
  - `toggleChecklistItem(db, organisationId, { taskId, index, done })` → task row
  - `setTaskVisibility(db, organisationId, { taskId, clientVisible, actorKind?, actorId? })` → task row
- Consumes: `assertOwned` (Plan 2), `recordAudit`, `recordActivity`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/tasks/assign-task.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { addStaffMember, seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { assignTask } from "./assign-task.js";
import { findOwnerUserId, pickLeastLoadedStaff } from "./assignee.js";

describe("assignment", () => {
  it("picks the member carrying the fewest unfinished tasks", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      expect(await findOwnerUserId(db, organisationId)).toBe(ownerUserId);

      const busy = await addStaffMember(db, organisationId, "Busy");
      const quiet = await addStaffMember(db, organisationId, "Quiet");
      for (const title of ["A", "B", "C"]) {
        await createTask(db, organisationId, { clientId, title, kind: "other", phase: "support", assigneeUserId: busy });
      }
      await createTask(db, organisationId, { clientId, title: "D", kind: "other", phase: "support", assigneeUserId: ownerUserId });
      // Finished work does not count against anyone.
      const done = await createTask(db, organisationId, { clientId, title: "E", kind: "other", phase: "support", assigneeUserId: quiet, status: "done" });
      expect(done.assigneeUserId).toBe(quiet);

      expect(await pickLeastLoadedStaff(db, organisationId)).toBe(quiet);
    });
  });

  it("assigns and unassigns, rejecting a user who is not a member", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const other = await seedOrgWithClient(db);
      const staffId = await addStaffMember(db, organisationId, "Shayan");
      const task = await createTask(db, organisationId, { clientId, title: "SEO setup", kind: "seo", phase: "onboarding" });

      expect((await assignTask(db, organisationId, { taskId: task.id, assigneeUserId: staffId })).assigneeUserId).toBe(staffId);
      expect((await assignTask(db, organisationId, { taskId: task.id, assigneeUserId: null })).assigneeUserId).toBeNull();
      await expect(assignTask(db, organisationId, { taskId: task.id, assigneeUserId: other.ownerUserId })).rejects.toThrow(/not an active member/);
    });
  });
});
```

`packages/core/src/tasks/task-detail.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { getTask } from "./get-task.js";
import { commentOnTask } from "./comment-on-task.js";
import { setTaskVisibility, toggleChecklistItem } from "./toggle-checklist-item.js";

describe("task detail writes", () => {
  it("appends comments, toggles checklist items immutably and flips client visibility", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const task = await createTask(db, organisationId, {
        clientId, title: "Content collection", kind: "content", phase: "onboarding",
        checklist: [{ label: "Logo" }, { label: "Photos" }, { label: "Copy" }],
      });

      await commentOnTask(db, organisationId, { taskId: task.id, bodyMd: "Chased the client", authorKind: "user", authorId: ownerUserId });
      await commentOnTask(db, organisationId, { taskId: task.id, bodyMd: "Photos received", authorKind: "user", authorId: ownerUserId });
      const loaded = await getTask(db, organisationId, task.id);
      expect(loaded?.comments.map((c) => c.bodyMd)).toEqual(["Chased the client", "Photos received"]);

      const toggled = await toggleChecklistItem(db, organisationId, { taskId: task.id, index: 1, done: true });
      expect(toggled.checklist).toEqual([{ label: "Logo", done: false }, { label: "Photos", done: true }, { label: "Copy", done: false }]);
      expect(task.checklist[1]!.done).toBe(false); // the original object was not mutated

      await expect(toggleChecklistItem(db, organisationId, { taskId: task.id, index: 9, done: true })).rejects.toThrow(/checklist index/);

      expect((await setTaskVisibility(db, organisationId, { taskId: task.id, clientVisible: false })).clientVisible).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./assignee.js`, `./assign-task.js`, `./comment-on-task.js` and `./toggle-checklist-item.js` cannot be resolved.

- [ ] **Step 3: `packages/core/src/tasks/assignee.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, count, eq, notInArray, sql } from "drizzle-orm";
import { FINISHED_STATUSES } from "./update-task-status.js";

/** The oldest active owner. Templates with `default_assignee_role: "owner"` land here. */
export async function findOwnerUserId(db: Db, organisationId: string): Promise<string | null> {
  const [row] = await db.select({ userId: schema.organisationMembers.userId })
    .from(schema.organisationMembers)
    .where(and(
      eq(schema.organisationMembers.organisationId, organisationId),
      eq(schema.organisationMembers.role, "owner"),
      eq(schema.organisationMembers.status, "active"),
    ))
    .orderBy(asc(schema.organisationMembers.createdAt))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * The active member with the fewest unfinished tasks. Owners are candidates
 * too — in a one-person agency Shoji is the only member. Ties go to the oldest
 * membership so the result is deterministic.
 */
export async function pickLeastLoadedStaff(db: Db, organisationId: string): Promise<string | null> {
  const [row] = await db.select({
    userId: schema.organisationMembers.userId,
    load: count(schema.tasks.id),
  })
    .from(schema.organisationMembers)
    .leftJoin(schema.tasks, and(
      eq(schema.tasks.assigneeUserId, schema.organisationMembers.userId),
      eq(schema.tasks.organisationId, organisationId),
      notInArray(schema.tasks.status, [...FINISHED_STATUSES]),
    ))
    .where(and(
      eq(schema.organisationMembers.organisationId, organisationId),
      eq(schema.organisationMembers.status, "active"),
    ))
    .groupBy(schema.organisationMembers.userId, schema.organisationMembers.createdAt)
    .orderBy(sql`count(${schema.tasks.id}) asc`, asc(schema.organisationMembers.createdAt))
    .limit(1);
  return row?.userId ?? null;
}
```

- [ ] **Step 4: `packages/core/src/tasks/assign-task.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";

export const AssignTaskInput = z.object({
  taskId: z.string().uuid(),
  assigneeUserId: z.string().min(1).nullable(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type AssignTaskInput = z.input<typeof AssignTaskInput>;

export async function assignTask(db: Db, organisationId: string, input: AssignTaskInput) {
  const v = AssignTaskInput.parse(input);
  const where = and(eq(schema.tasks.id, v.taskId), eq(schema.tasks.organisationId, organisationId));
  const [before] = await db.select().from(schema.tasks).where(where);
  if (!before) throw new Error(`task ${v.taskId} not found in organisation`);

  if (v.assigneeUserId) {
    const [member] = await db.select({ id: schema.organisationMembers.id })
      .from(schema.organisationMembers)
      .where(and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.userId, v.assigneeUserId),
        eq(schema.organisationMembers.status, "active"),
      ));
    if (!member) throw new Error(`user ${v.assigneeUserId} is not an active member of this organisation`);
  }

  const [after] = await db.update(schema.tasks)
    .set({ assigneeUserId: v.assigneeUserId, updatedAt: new Date() })
    .where(where).returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "task.assigned",
    targetType: "task", targetId: v.taskId, before, after,
  });
  await recordActivity(db, organisationId, {
    clientId: after!.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "task.assigned",
    title: v.assigneeUserId ? `${after!.title} assigned` : `${after!.title} unassigned`,
    link: `/tasks/${v.taskId}`,
  });
  return after!;
}
```

- [ ] **Step 5: `packages/core/src/tasks/comment-on-task.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { assertOwned } from "../tenancy/assert-owned.js";

export const CommentOnTaskInput = z.object({
  taskId: z.string().uuid(),
  bodyMd: z.string().min(1).max(10000),
  authorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  authorId: z.string().optional(),
});
export type CommentOnTaskInput = z.input<typeof CommentOnTaskInput>;

/**
 * Comments are append-only conversation, not business record mutation, so they
 * carry no audit row — the comment itself is the record.
 */
export async function commentOnTask(db: Db, organisationId: string, input: CommentOnTaskInput) {
  const v = CommentOnTaskInput.parse(input);
  await assertOwned(db, organisationId, schema.tasks, v.taskId);
  const [comment] = await db.insert(schema.taskComments).values({
    organisationId, taskId: v.taskId, authorKind: v.authorKind, authorId: v.authorId ?? null, bodyMd: v.bodyMd,
  }).returning();
  return comment!;
}
```

- [ ] **Step 6: `packages/core/src/tasks/toggle-checklist-item.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const ToggleChecklistItemInput = z.object({
  taskId: z.string().uuid(),
  index: z.number().int().min(0).max(49),
  done: z.boolean(),
});
export type ToggleChecklistItemInput = z.infer<typeof ToggleChecklistItemInput>;

export async function toggleChecklistItem(db: Db, organisationId: string, input: ToggleChecklistItemInput) {
  const v = ToggleChecklistItemInput.parse(input);
  const where = and(eq(schema.tasks.id, v.taskId), eq(schema.tasks.organisationId, organisationId));
  const [before] = await db.select().from(schema.tasks).where(where);
  if (!before) throw new Error(`task ${v.taskId} not found in organisation`);
  if (v.index >= before.checklist.length) throw new Error(`checklist index ${v.index} is out of range`);

  // New array, new items — the loaded row is never mutated.
  const checklist = before.checklist.map((item, i) => (i === v.index ? { ...item, done: v.done } : item));
  const [after] = await db.update(schema.tasks).set({ checklist, updatedAt: new Date() }).where(where).returning();
  return after!;
}

export const SetTaskVisibilityInput = z.object({
  taskId: z.string().uuid(),
  clientVisible: z.boolean(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type SetTaskVisibilityInput = z.input<typeof SetTaskVisibilityInput>;

/** Whether this task appears in the client portal's task list (P4 renders it). */
export async function setTaskVisibility(db: Db, organisationId: string, input: SetTaskVisibilityInput) {
  const v = SetTaskVisibilityInput.parse(input);
  const where = and(eq(schema.tasks.id, v.taskId), eq(schema.tasks.organisationId, organisationId));
  const [before] = await db.select().from(schema.tasks).where(where);
  if (!before) throw new Error(`task ${v.taskId} not found in organisation`);
  const [after] = await db.update(schema.tasks)
    .set({ clientVisible: v.clientVisible, updatedAt: new Date() }).where(where).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "task.visibility_changed",
    targetType: "task", targetId: v.taskId, before, after,
  });
  return after!;
}
```

- [ ] **Step 7: Barrel exports**

Append to `packages/core/src/index.ts`:
```ts
export { findOwnerUserId, pickLeastLoadedStaff } from "./tasks/assignee.js";
export { assignTask, AssignTaskInput } from "./tasks/assign-task.js";
export { commentOnTask, CommentOnTaskInput } from "./tasks/comment-on-task.js";
export { setTaskVisibility, toggleChecklistItem, SetTaskVisibilityInput, ToggleChecklistItemInput } from "./tasks/toggle-checklist-item.js";
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): task assignment, least-loaded picker, comments, checklist toggle and client visibility"
```

---

### Task 6: Core — generateOnboardingTasks

**Files:**
- Create: `packages/core/src/tasks/generate-onboarding-tasks.ts`, `generate-onboarding-tasks.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `generateOnboardingTasks(db, organisationId, clientId)` → `{ created: Task[]; skipped: number }`. Selects `task_templates` where `phase = 'onboarding'` and (`package_id IS NULL` or `= client.package_id`), ordered by `sort_order`. Due date = `client.created_at + offset_days`. Assignee by `default_assignee_role`: `owner` → `findOwnerUserId`, `staff` → `pickLeastLoadedStaff`, `any` → unassigned. Idempotent by `(client_id, template_id)`.
- Consumes: `listTaskTemplates`, `createTask`, `findOwnerUserId`, `pickLeastLoadedStaff`, `addDays`, `assertClientInOrganisation`, `recordActivity`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/tasks/generate-onboarding-tasks.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createTaskTemplate } from "../packages/create-task-template.js";
import { addStaffMember, seedOrgWithClient } from "./test-fixtures.js";
import { generateOnboardingTasks } from "./generate-onboarding-tasks.js";
import { listTasks } from "./list-tasks.js";

describe("generateOnboardingTasks", () => {
  it("creates one task per matching template, dated from the client, assigned by role", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId, ownerUserId } = await seedOrgWithClient(db);
      const staffId = await addStaffMember(db, organisationId, "Shayan");
      const [otherPkg] = await db.insert(schema.packages)
        .values({ organisationId, name: "Other", slug: `other-${crypto.randomUUID()}` }).returning();

      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "other", title: "Discovery call", offsetDays: 1, sortOrder: 10, defaultAssigneeRole: "owner" });
      await createTaskTemplate(db, organisationId, { packageId, phase: "onboarding", kind: "seo", title: "SEO setup", offsetDays: 20, sortOrder: 20, defaultAssigneeRole: "staff", checklist: ["Sitemap", "GSC"] });
      await createTaskTemplate(db, organisationId, { packageId: otherPkg!.id, phase: "onboarding", kind: "build", title: "Not this package", sortOrder: 30 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "social", title: "Social post", recurrence: "monthly" });

      const first = await generateOnboardingTasks(db, organisationId, clientId);
      expect(first.created.map((t) => t.title)).toEqual(["Discovery call", "SEO setup"]);
      expect(first.skipped).toBe(0);
      expect(first.created[0]!.assigneeUserId).toBe(ownerUserId);
      expect(first.created[1]!.assigneeUserId).toBe(staffId);
      expect(first.created[1]!.checklist).toEqual([{ label: "Sitemap", done: false }, { label: "GSC", done: false }]);
      expect(first.created[1]!.phase).toBe("onboarding");

      const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
      expect(first.created[0]!.dueAt!.getTime()).toBe(client!.createdAt.getTime() + 86_400_000);

      // Idempotent: a second run adds nothing.
      const second = await generateOnboardingTasks(db, organisationId, clientId);
      expect(second.created).toEqual([]);
      expect(second.skipped).toBe(2);
      expect(await listTasks(db, organisationId, { clientId, phase: "onboarding" })).toHaveLength(2);

      // A template added later is topped up on the next run.
      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "handover", title: "Handover", offsetDays: 28, sortOrder: 40 });
      const third = await generateOnboardingTasks(db, organisationId, clientId);
      expect(third.created.map((t) => t.title)).toEqual(["Handover"]);
      expect(third.created[0]!.assigneeUserId).toBeNull();
    });
  });

  it("uses only global templates when the client has no package", async () => {
    await withTestDb(async (db) => {
      const { organisationId, packageId } = await seedOrgWithClient(db);
      const [client] = await db.insert(schema.clients)
        .values({ organisationId, name: "No package", slug: `np-${crypto.randomUUID()}` }).returning();
      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "other", title: "Global", sortOrder: 10 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "onboarding", kind: "seo", title: "Package only", sortOrder: 20 });

      const result = await generateOnboardingTasks(db, organisationId, client!.id);
      expect(result.created.map((t) => t.title)).toEqual(["Global"]);
      const activity = await db.select().from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.clientId, client!.id), eq(schema.activityEvents.kind, "tasks.onboarding_generated")));
      expect(activity).toHaveLength(1);
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await expect(generateOnboardingTasks(db, b.organisationId, a.clientId)).rejects.toThrow(/not found in organisation/);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./generate-onboarding-tasks.js` cannot be resolved.

- [ ] **Step 3: `packages/core/src/tasks/generate-onboarding-tasks.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { TaskAssigneeRole } from "@launchos/db/schema";
import { and, eq } from "drizzle-orm";
import { recordActivity } from "../activity/record-activity.js";
import { listTaskTemplates } from "../packages/list-task-templates.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";
import { findOwnerUserId, pickLeastLoadedStaff } from "./assignee.js";
import { createTask } from "./create-task.js";
import { addDays } from "./dates.js";

/**
 * Turns a client's package into its onboarding task list.
 *
 * Idempotent by (client_id, template_id): running it again after the package
 * changed, or after a template was added, tops up what is missing and touches
 * nothing that already exists. The partial unique index on `tasks` backstops
 * the pre-filter if two runs race.
 */
export async function generateOnboardingTasks(db: Db, organisationId: string, clientId: string) {
  await assertClientInOrganisation(db, organisationId, clientId);
  const [client] = await db.select().from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  if (!client) throw new Error(`client ${clientId} not found in organisation`);

  // With a package: that package's templates plus the global ones. Without a
  // package: global templates only — `includeGlobal: false` and no packageId
  // filters to `package_id IS NULL`.
  const templates = client.packageId
    ? await listTaskTemplates(db, organisationId, { phase: "onboarding", packageId: client.packageId, includeGlobal: true })
    : await listTaskTemplates(db, organisationId, { phase: "onboarding", includeGlobal: false });

  const existing = await db.select({ templateId: schema.tasks.templateId })
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.organisationId, organisationId),
      eq(schema.tasks.clientId, clientId),
      eq(schema.tasks.phase, "onboarding"),
    ));
  const alreadyGenerated = new Set(existing.map((r) => r.templateId).filter((v): v is string => v !== null));

  const pending = templates.filter((t) => !alreadyGenerated.has(t.id));
  const ownerUserId = pending.some((t) => t.defaultAssigneeRole === "owner") ? await findOwnerUserId(db, organisationId) : null;
  const staffUserId = pending.some((t) => t.defaultAssigneeRole === "staff") ? await pickLeastLoadedStaff(db, organisationId) : null;
  const assigneeFor = (role: TaskAssigneeRole) =>
    (role === "owner" ? ownerUserId : role === "staff" ? staffUserId : null) ?? undefined;

  const created = [];
  for (const template of pending) {
    created.push(await createTask(db, organisationId, {
      clientId,
      templateId: template.id,
      title: template.title,
      kind: template.kind,
      phase: "onboarding",
      descriptionMd: template.descriptionMd ?? undefined,
      dueAt: addDays(client.createdAt, template.offsetDays),
      assigneeUserId: assigneeFor(template.defaultAssigneeRole),
      checklist: template.checklist.map((label) => ({ label, done: false })),
      actorKind: "system",
    }));
  }

  if (created.length > 0) {
    await recordActivity(db, organisationId, {
      clientId,
      actorKind: "system",
      kind: "tasks.onboarding_generated",
      title: `${created.length} onboarding task${created.length === 1 ? "" : "s"} generated`,
      link: `/clients/${clientId}/tasks`,
    });
  }

  return { created, skipped: templates.length - created.length };
}
```

- [ ] **Step 4: Barrel export**

Append to `packages/core/src/index.ts`:
```ts
export { generateOnboardingTasks } from "./tasks/generate-onboarding-tasks.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): idempotent onboarding task generation from package templates"
```

---

### Task 7: Core — generateRecurringTasks

**Files:**
- Create: `packages/core/src/tasks/generate-recurring-tasks.ts`, `generate-recurring-tasks.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `quantityFor(kind: TaskKind, recurrence: TaskRecurrence, includes: PackageIncludes): number` — `social` → `socialPostsPerMonth`, `content` → `blogPostsPerMonth`, `gbp` → `gbpUpdatesPerMonth` for monthly templates; `seo` → 0 when `includes.seo` is false; otherwise 1
  - `generateRecurringTasks(db, organisationId, { now? })` → `{ created: number; skipped: number }`. For every active client with an active package, for every recurring template matching that package, creates `quantity` tasks keyed `"<kind>:<periodKey>:<n>"`, idempotent by `(client_id, recurrence_key)`.
- Consumes: `listTaskTemplates`, `getPackage`, `createTask`, `periodBounds`, `dueWithinPeriod`, `pickLeastLoadedStaff`, `findOwnerUserId`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/tasks/generate-recurring-tasks.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createTaskTemplate } from "../packages/create-task-template.js";
import { updatePackage } from "../packages/update-package.js";
import { seedOrgWithClient } from "./test-fixtures.js";
import { generateRecurringTasks, quantityFor } from "./generate-recurring-tasks.js";
import { listTasks } from "./list-tasks.js";

const NOW = new Date("2026-10-14T06:00:00.000Z");

describe("quantityFor", () => {
  const includes = { website: true, seo: true, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 };
  it("reads monthly quantities from the package and gates SEO", () => {
    expect(quantityFor("social", "monthly", includes)).toBe(4);
    expect(quantityFor("content", "monthly", includes)).toBe(1);
    expect(quantityFor("gbp", "monthly", includes)).toBe(2);
    expect(quantityFor("seo", "quarterly", includes)).toBe(1);
    expect(quantityFor("seo", "quarterly", { ...includes, seo: false })).toBe(0);
    expect(quantityFor("social", "quarterly", includes)).toBe(1);
    expect(quantityFor("other", "monthly", includes)).toBe(1);
  });
});

describe("generateRecurringTasks", () => {
  it("creates the package quantity once per period and never twice", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId } = await seedOrgWithClient(db);
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "social", title: "Social post", recurrence: "monthly", sortOrder: 10 });
      await createTaskTemplate(db, organisationId, { phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly", sortOrder: 20 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "seo", title: "SEO audit", recurrence: "quarterly", sortOrder: 30 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "review", title: "Never generated", recurrence: "none", sortOrder: 40 });

      const first = await generateRecurringTasks(db, organisationId, { now: NOW });
      expect(first).toEqual({ created: 6, skipped: 0 }); // 4 social + 1 blog + 1 SEO audit

      const rows = await listTasks(db, organisationId, { clientId, phase: "recurring" });
      expect(rows).toHaveLength(6);
      const keys = (await db.select().from(schema.tasks).where(eq(schema.tasks.clientId, clientId))).map((t) => t.recurrenceKey);
      expect(keys).toContain("social:2026-10:1");
      expect(keys).toContain("social:2026-10:4");
      expect(keys).toContain("content:2026-10:1");
      expect(keys).toContain("seo:2026-Q4:1");
      expect(rows.find((r) => r.title === "Social post 1/4")).toBeDefined();
      expect(rows.find((r) => r.title === "Blog post")).toBeDefined();

      const second = await generateRecurringTasks(db, organisationId, { now: NOW });
      expect(second).toEqual({ created: 0, skipped: 6 });
      expect(await listTasks(db, organisationId, { clientId, phase: "recurring" })).toHaveLength(6);

      // The next month is a new period.
      const next = await generateRecurringTasks(db, organisationId, { now: new Date("2026-11-03T06:00:00.000Z") });
      expect(next.created).toBe(5); // the quarterly SEO audit is still in Q4
    });
  });

  it("skips clients without a package, paused clients and inactive packages", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId } = await seedOrgWithClient(db);
      await createTaskTemplate(db, organisationId, { phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly" });
      await db.insert(schema.clients).values({ organisationId, name: "No package", slug: `np-${crypto.randomUUID()}` });

      await db.update(schema.clients).set({ status: "paused" }).where(eq(schema.clients.id, clientId));
      expect(await generateRecurringTasks(db, organisationId, { now: NOW })).toEqual({ created: 0, skipped: 0 });

      await db.update(schema.clients).set({ status: "active" }).where(eq(schema.clients.id, clientId));
      await updatePackage(db, organisationId, { packageId, active: false });
      expect(await generateRecurringTasks(db, organisationId, { now: NOW })).toEqual({ created: 0, skipped: 0 });

      await updatePackage(db, organisationId, { packageId, active: true });
      expect(await generateRecurringTasks(db, organisationId, { now: NOW })).toEqual({ created: 1, skipped: 0 });
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./generate-recurring-tasks.js` cannot be resolved.

- [ ] **Step 3: `packages/core/src/tasks/generate-recurring-tasks.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PackageIncludes, TaskAssigneeRole, TaskKind, TaskRecurrence } from "@launchos/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { getPackage } from "../packages/list-packages.js";
import { listTaskTemplates } from "../packages/list-task-templates.js";
import { findOwnerUserId, pickLeastLoadedStaff } from "./assignee.js";
import { createTask } from "./create-task.js";
import { dueWithinPeriod, periodBounds } from "./dates.js";

/**
 * How many of this template to create for the current period. Monthly
 * quantities come from the package; anything else is one per period. An SEO
 * template on a package without SEO produces nothing.
 */
export function quantityFor(kind: TaskKind, recurrence: TaskRecurrence, includes: PackageIncludes): number {
  if (kind === "seo" && !includes.seo) return 0;
  if (recurrence !== "monthly") return 1;
  if (kind === "social") return includes.socialPostsPerMonth;
  if (kind === "content") return includes.blogPostsPerMonth;
  if (kind === "gbp") return includes.gbpUpdatesPerMonth;
  return 1;
}

export const GenerateRecurringTasksInput = z.object({ now: z.coerce.date().default(() => new Date()) });
export type GenerateRecurringTasksInput = z.input<typeof GenerateRecurringTasksInput>;

/**
 * The daily 06:00 sweep. Every active client on an active package gets the
 * period's service work created once. Idempotency is the (client_id,
 * recurrence_key) unique index; the pre-check keeps the common re-run cheap
 * and the index turns a genuine race into an error rather than a duplicate.
 */
export async function generateRecurringTasks(db: Db, organisationId: string, input: GenerateRecurringTasksInput = {}) {
  const { now } = GenerateRecurringTasksInput.parse(input);
  const clients = await db.select().from(schema.clients).where(and(
    eq(schema.clients.organisationId, organisationId),
    eq(schema.clients.status, "active"),
    isNotNull(schema.clients.packageId),
  ));

  let created = 0;
  let skipped = 0;

  for (const client of clients) {
    const pkg = await getPackage(db, organisationId, client.packageId!);
    if (!pkg || !pkg.active) continue;

    const templates = (await listTaskTemplates(db, organisationId, {
      phase: "recurring", packageId: pkg.id, includeGlobal: true,
    })).filter((t) => t.recurrence !== "none");

    for (const template of templates) {
      const quantity = quantityFor(template.kind, template.recurrence, pkg.includes);
      if (quantity < 1) continue;
      const period = periodBounds(template.recurrence, now);

      for (let n = 1; n <= quantity; n += 1) {
        const recurrenceKey = `${template.kind}:${period.key}:${n}`;
        const [existing] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
          eq(schema.tasks.clientId, client.id),
          eq(schema.tasks.recurrenceKey, recurrenceKey),
        ));
        if (existing) { skipped += 1; continue; }

        await createTask(db, organisationId, {
          clientId: client.id,
          templateId: template.id,
          title: quantity > 1 ? `${template.title} ${n}/${quantity}` : template.title,
          kind: template.kind,
          phase: "recurring",
          descriptionMd: template.descriptionMd ?? undefined,
          dueAt: dueWithinPeriod(period, n, quantity),
          assigneeUserId: await assigneeFor(db, organisationId, template.defaultAssigneeRole),
          checklist: template.checklist.map((label) => ({ label, done: false })),
          recurrenceKey,
          actorKind: "system",
        });
        created += 1;
      }
    }
  }

  return { created, skipped };
}

async function assigneeFor(db: Db, organisationId: string, role: TaskAssigneeRole): Promise<string | undefined> {
  if (role === "owner") return (await findOwnerUserId(db, organisationId)) ?? undefined;
  if (role === "staff") return (await pickLeastLoadedStaff(db, organisationId)) ?? undefined;
  return undefined;
}
```

- [ ] **Step 4: Barrel export**

Append to `packages/core/src/index.ts`:
```ts
export { generateRecurringTasks, quantityFor, GenerateRecurringTasksInput } from "./tasks/generate-recurring-tasks.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): recurring service task generation keyed by period and package quantities"
```

---

### Task 8: Core — overdue detection and notifications

**Files:**
- Create: `packages/core/src/tasks/find-overdue-tasks.ts`, `find-overdue-tasks.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `findOverdueTasks(db, organisationId, { now? })` → task rows with `due_at < now` and status outside `done`/`cancelled`, oldest due first
  - `notifyOverdueTasks(db, organisationId, { now? })` → `{ overdue: number; notified: number }`. Notifies the owner and, when set, the assignee; writes `metadata.lastOverdueNotifiedOn = londonDateKey(now)` so a task is chased at most once a day; emits `task.overdue` per notified task.
- Consumes: `notify`, `notifyOwner` (Plan 2), `emit`, `londonDateKey`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/tasks/find-overdue-tasks.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { addStaffMember, seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { updateTaskStatus } from "./update-task-status.js";
import { findOverdueTasks, notifyOverdueTasks } from "./find-overdue-tasks.js";

const NOW = new Date("2026-10-14T08:00:00.000Z");
const past = (iso: string) => new Date(iso);

describe("overdue tasks", () => {
  it("finds only unfinished tasks past their due date", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const late = await createTask(db, organisationId, { clientId, title: "Late", kind: "other", phase: "support", dueAt: past("2026-10-10T09:00:00.000Z") });
      await createTask(db, organisationId, { clientId, title: "Future", kind: "other", phase: "support", dueAt: past("2026-10-20T09:00:00.000Z") });
      await createTask(db, organisationId, { clientId, title: "Undated", kind: "other", phase: "support" });
      const finished = await createTask(db, organisationId, { clientId, title: "Finished", kind: "other", phase: "support", dueAt: past("2026-10-01T09:00:00.000Z") });
      await updateTaskStatus(db, organisationId, { taskId: finished.id, status: "done" });

      expect((await findOverdueTasks(db, organisationId, { now: NOW })).map((t) => t.id)).toEqual([late.id]);
    });
  });

  it("notifies owner and assignee once a day and emits task.overdue", async () => {
    await withTestDb(async (db) => {
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const staffId = await addStaffMember(db, organisationId, "Shayan");
      const task = await createTask(db, organisationId, {
        clientId, title: "DNS cutover", kind: "dns", phase: "onboarding",
        dueAt: past("2026-10-10T09:00:00.000Z"), assigneeUserId: staffId,
      });

      expect(await notifyOverdueTasks(db, organisationId, { now: NOW })).toEqual({ overdue: 1, notified: 1 });
      const notifications = await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "task.overdue"));
      expect(notifications.map((n) => n.userId).sort()).toEqual([ownerUserId, staffId].sort());
      expect(events.filter((e) => e.name === "task.overdue")).toEqual([{ name: "task.overdue", organisationId, taskId: task.id }]);

      // Same London day: no second notification.
      expect(await notifyOverdueTasks(db, organisationId, { now: new Date("2026-10-14T20:00:00.000Z") })).toEqual({ overdue: 1, notified: 0 });
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "task.overdue"))).toHaveLength(2);

      // Next day: chased again.
      expect(await notifyOverdueTasks(db, organisationId, { now: new Date("2026-10-15T08:00:00.000Z") })).toEqual({ overdue: 1, notified: 1 });
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "task.overdue"))).toHaveLength(4);

      const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
      expect((row!.metadata as { lastOverdueNotifiedOn?: string }).lastOverdueNotifiedOn).toBe("2026-10-15");
      setEnqueue(async () => {});
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./find-overdue-tasks.js` cannot be resolved.

- [ ] **Step 3: `packages/core/src/tasks/find-overdue-tasks.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, isNotNull, lt, notInArray } from "drizzle-orm";
import { z } from "zod";
import { emit } from "../events/emit.js";
import { notify, notifyOwner } from "../notifications/notify.js";
import { londonDateKey } from "./dates.js";
import { FINISHED_STATUSES } from "./update-task-status.js";

export const OverdueInput = z.object({ now: z.coerce.date().default(() => new Date()) });
export type OverdueInput = z.input<typeof OverdueInput>;

export async function findOverdueTasks(db: Db, organisationId: string, input: OverdueInput = {}) {
  const { now } = OverdueInput.parse(input);
  return db.select().from(schema.tasks).where(and(
    eq(schema.tasks.organisationId, organisationId),
    isNotNull(schema.tasks.dueAt),
    lt(schema.tasks.dueAt, now),
    notInArray(schema.tasks.status, [...FINISHED_STATUSES]),
  )).orderBy(asc(schema.tasks.dueAt));
}

/**
 * The daily 08:00 chase. `metadata.lastOverdueNotifiedOn` holds the London
 * date of the last nudge, so a task that stays late produces one notification
 * a day rather than one per sweep — and re-running the cron after a restart is
 * free.
 */
export async function notifyOverdueTasks(db: Db, organisationId: string, input: OverdueInput = {}) {
  const { now } = OverdueInput.parse(input);
  const today = londonDateKey(now);
  const overdue = await findOverdueTasks(db, organisationId, { now });
  let notified = 0;

  for (const task of overdue) {
    const metadata = task.metadata as { lastOverdueNotifiedOn?: string };
    if (metadata.lastOverdueNotifiedOn === today) continue;

    const link = `/tasks/${task.id}`;
    const title = `Task overdue: ${task.title}`;
    const body = task.dueAt ? `Due ${londonDateKey(task.dueAt)}` : undefined;

    await notifyOwner(db, organisationId, { kind: "task.overdue", title, body, link });
    if (task.assigneeUserId) {
      await notify(db, organisationId, { userId: task.assigneeUserId, kind: "task.overdue", title, body, link });
    }

    await db.update(schema.tasks)
      .set({ metadata: { ...metadata, lastOverdueNotifiedOn: today }, updatedAt: new Date() })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.organisationId, organisationId)));

    await emit({ name: "task.overdue", organisationId, taskId: task.id });
    notified += 1;
  }

  return { overdue: overdue.length, notified };
}
```

If Plan 2's `notifyOwner` resolves to the same user as an assignee who happens to be the owner, two rows are written; that is intended — the owner sees it in both roles and the notification list de-duplicates visually by title.

- [ ] **Step 4: Barrel export**

Append to `packages/core/src/index.ts`:
```ts
export { findOverdueTasks, notifyOverdueTasks, OverdueInput } from "./tasks/find-overdue-tasks.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS. All of `@launchos/core`'s task tests are green at this point.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): overdue task detection with once-a-day owner and assignee notifications"
```

---

### Task 9: Worker and web queue — onboarding job and two daily crons

**Files:**
- Create: `apps/worker/src/jobs/task-generation.ts`, `apps/worker/src/jobs/task-generation.test.ts`
- Modify: `apps/worker/src/boss.ts`, `apps/worker/src/index.ts`, `apps/web/src/lib/queue.ts`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Produces:
  - `QUEUE.tasksGenerateOnboarding = "tasks.generate-onboarding"`, `QUEUE.tasksGenerateRecurring = "tasks.generate-recurring"`, `QUEUE.tasksCheckOverdue = "tasks.check-overdue"`
  - `type GenerateOnboardingJob = { organisationId: string; clientId: string }`
  - `handleGenerateOnboarding(db, job)` → `{ created: number; skipped: number }`
  - `runRecurringSweep(db, now)` → `{ organisations: number; created: number; skipped: number }`
  - `runOverdueSweep(db, now)` → `{ organisations: number; overdue: number; notified: number }`
- Consumes: `generateOnboardingTasks`, `generateRecurringTasks`, `notifyOverdueTasks`, `setEnqueue`, `createBoss`.

- [ ] **Step 1: Write the failing test**

`apps/worker/src/jobs/task-generation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { createTaskTemplate } from "@launchos/core";
import { randomUUID } from "node:crypto";
import { handleGenerateOnboarding, runOverdueSweep, runRecurringSweep } from "./task-generation.js";

async function world(db: Parameters<typeof handleGenerateOnboarding>[0]) {
  const [org] = await db.insert(schema.organisations).values({ name: "W", slug: `w-${randomUUID()}` }).returning();
  const [owner] = await db.insert(schema.user).values({ id: randomUUID(), name: "O", email: `o-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: owner!.id, role: "owner", status: "active" });
  const [pkg] = await db.insert(schema.packages).values({
    organisationId: org!.id, name: "Care", slug: `care-${randomUUID()}`,
    includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 0 },
  }).returning();
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}`, packageId: pkg!.id }).returning();
  return { organisationId: org!.id, clientId: client!.id, packageId: pkg!.id };
}

describe("task generation jobs", () => {
  it("generates onboarding tasks for one client and is safe to re-run", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await world(db);
      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "build", title: "Build website", offsetDays: 14 });
      expect(await handleGenerateOnboarding(db, { organisationId, clientId })).toEqual({ created: 1, skipped: 0 });
      expect(await handleGenerateOnboarding(db, { organisationId, clientId })).toEqual({ created: 0, skipped: 1 });
    });
  });

  it("sweeps every organisation for recurring work and overdue chases", async () => {
    await withTestDb(async (db) => {
      const a = await world(db);
      const b = await world(db);
      for (const w of [a, b]) {
        await createTaskTemplate(db, w.organisationId, { phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly" });
      }
      const now = new Date("2026-10-14T06:00:00.000Z");
      const recurring = await runRecurringSweep(db, now);
      expect(recurring.created).toBe(2);
      expect(recurring.organisations).toBeGreaterThanOrEqual(2);

      const overdue = await runOverdueSweep(db, new Date("2026-12-01T08:00:00.000Z"));
      expect(overdue.notified).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @launchos/worker test`
Expected: FAIL — `./task-generation.js` cannot be resolved.

- [ ] **Step 3: `apps/worker/src/jobs/task-generation.ts`**

```ts
import { generateOnboardingTasks, generateRecurringTasks, notifyOverdueTasks } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";

export type GenerateOnboardingJob = { organisationId: string; clientId: string };

export async function handleGenerateOnboarding(db: Db, job: GenerateOnboardingJob) {
  const { created, skipped } = await generateOnboardingTasks(db, job.organisationId, job.clientId);
  return { created: created.length, skipped };
}

async function organisationIds(db: Db) {
  const rows = await db.select({ id: schema.organisations.id }).from(schema.organisations)
    .where(eq(schema.organisations.status, "active"));
  return rows.map((r) => r.id);
}

/** Daily 06:00 Europe/London: this period's service work for every organisation. */
export async function runRecurringSweep(db: Db, now: Date) {
  const ids = await organisationIds(db);
  let created = 0;
  let skipped = 0;
  for (const organisationId of ids) {
    const result = await generateRecurringTasks(db, organisationId, { now });
    created += result.created;
    skipped += result.skipped;
  }
  return { organisations: ids.length, created, skipped };
}

/** Daily 08:00 Europe/London: chase everything past its due date. */
export async function runOverdueSweep(db: Db, now: Date) {
  const ids = await organisationIds(db);
  let overdue = 0;
  let notified = 0;
  for (const organisationId of ids) {
    const result = await notifyOverdueTasks(db, organisationId, { now });
    overdue += result.overdue;
    notified += result.notified;
  }
  return { organisations: ids.length, overdue, notified };
}
```

- [ ] **Step 4: Queue names in `apps/worker/src/boss.ts`**

```ts
export const QUEUE = {
  monitorCheck: "monitor.check",
  agentRun: "agent.run",
  tasksGenerateOnboarding: "tasks.generate-onboarding",
  tasksGenerateRecurring: "tasks.generate-recurring",
  tasksCheckOverdue: "tasks.check-overdue",
} as const;
```
`createBoss` already loops `Object.values(QUEUE)` calling `boss.createQueue`, so the three new queues are created at boot with no further change.

- [ ] **Step 5: Wire `apps/worker/src/index.ts`**

Add the imports:
```ts
import { handleGenerateOnboarding, runOverdueSweep, runRecurringSweep, type GenerateOnboardingJob } from "./jobs/task-generation.js";
```

Inside the existing `setEnqueue` callback, after the `incident.opened` branch:
```ts
    if (event.name === "client.created") {
      const job: GenerateOnboardingJob = { organisationId: event.organisationId, clientId: event.clientId };
      await boss.send(QUEUE.tasksGenerateOnboarding, job, { singletonKey: `onboarding:${event.clientId}` });
    }
```

After the existing `boss.work` registrations:
```ts
  await boss.work<GenerateOnboardingJob>(QUEUE.tasksGenerateOnboarding, async ([job]) => {
    const result = await handleGenerateOnboarding(db, job!.data);
    console.info({ client: job!.data.clientId, ...result }, "onboarding tasks generated");
  });
  await boss.work(QUEUE.tasksGenerateRecurring, async () => {
    console.info(await runRecurringSweep(db, new Date()), "recurring task sweep");
  });
  await boss.work(QUEUE.tasksCheckOverdue, async () => {
    console.info(await runOverdueSweep(db, new Date()), "overdue task sweep");
  });
```

Beside the existing `monitor.check` schedule:
```ts
  await boss.schedule(QUEUE.tasksGenerateRecurring, "0 6 * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.tasksCheckOverdue, "0 8 * * *", {}, { tz: "Europe/London" });
```

- [ ] **Step 6: Map `client.created` in `apps/web/src/lib/queue.ts`**

Add a branch alongside Plan 2's existing branches in the `enqueue` function. The web app does not depend on `@launchos/worker`, so the queue name is a string literal here and must stay in step with `QUEUE.tasksGenerateOnboarding`:
```ts
  if (event.name === "client.created") {
    await boss.send(
      "tasks.generate-onboarding",
      { organisationId: event.organisationId, clientId: event.clientId },
      { singletonKey: `onboarding:${event.clientId}` },
    );
    return;
  }
```
The queue is created by the worker at boot. If the worker has never run against this database the send fails; the admin UI's "Generate onboarding tasks" button (Task 11) covers that case, so a client is never stuck without its tasks.

- [ ] **Step 7: Document the queues**

In `docs/ARCHITECTURE.md`, add three rows to the Queues table:

| Queue | Producer | Consumer | Payload |
|---|---|---|---|
| `tasks.generate-onboarding` | `client.created` event (web or worker) | worker | `{ organisationId, clientId }` |
| `tasks.generate-recurring` | cron daily 06:00 Europe/London | worker | `{}` — sweeps every active organisation |
| `tasks.check-overdue` | cron daily 08:00 Europe/London | worker | `{}` — sweeps every active organisation |

- [ ] **Step 8: Run the test and a smoke boot**

Run: `pnpm --filter @launchos/worker test`
Expected: PASS.

Run: `pnpm db:up && pnpm db:migrate` then, in PowerShell, `$env:LLM="fake"; pnpm dev:worker`.
Expected: `worker started` with no queue-creation error; Ctrl-C to stop.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(worker): onboarding generation job plus daily recurring and overdue crons"
```

---

### Task 10: Web — Tasks list and board, filters, New task dialog, nav, dashboard cards

**Files:**
- Create: `apps/web/src/app/(admin)/tasks/page.tsx`, `actions.ts`, `task-filters.tsx`, `task-board.tsx`, `task-row-status.tsx`, `new-task-dialog.tsx`
- Modify: `apps/web/src/app/(admin)/layout.tsx`, `apps/web/src/app/(admin)/page.tsx`, `apps/web/src/components/status-badge.tsx`

**Interfaces:**
- Produces: route `/tasks` with `?view=list|board` and filter search params `client`, `status`, `assignee`, `phase`, `kind`, `dueFrom`, `dueTo`; server actions `createTaskAction(formData)`, `updateTaskStatusAction(formData)` in `apps/web/src/app/(admin)/tasks/actions.ts`.
- Consumes: `listTasks`, `createTask`, `updateTaskStatus`, `listPackages`, `listMembers` (Plan 2), `requireAdmin`, `getDb`.

- [ ] **Step 1: Add the shadcn primitives this plan needs**

Run from `apps/web`: `pnpm dlx shadcn@latest add input label select textarea checkbox dialog`
Expected: components land in `apps/web/src/components/ui/`. Keep any file Plan 2 already added — answer "no" to overwrite prompts.

- [ ] **Step 2: Status colours for the new enums**

In `apps/web/src/components/status-badge.tsx`, add to `TONE_BY_VALUE`:
```ts
  // task status
  todo: "neutral",
  blocked: "danger",
  review: "info",
  done: "success",
  cancelled: "neutral",
  // task priority
  urgent: "danger",
  // task phase
  onboarding: "info",
  recurring: "neutral",
  support: "warn",
```
`in_progress`, `low`, `medium`, `high` are already mapped.

- [ ] **Step 3: `apps/web/src/app/(admin)/tasks/actions.ts`**

```ts
"use server";

import { createTask, updateTaskStatus } from "@launchos/core";
import { schema } from "@launchos/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const CreateTaskForm = z.object({
  clientId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  phase: z.enum(schema.taskPhaseEnum.enumValues),
  kind: z.enum(schema.taskKindEnum.enumValues),
  priority: z.enum(schema.taskPriorityEnum.enumValues),
  dueAt: z.string().trim().optional(),
  assigneeUserId: z.string().trim().optional(),
  descriptionMd: z.string().trim().max(20000).optional(),
});

/** Server Actions accept direct POSTs, so every action re-authorises and re-validates. */
export async function createTaskAction(formData: FormData) {
  const session = await requireAdmin();
  const v = CreateTaskForm.parse({
    clientId: formData.get("clientId"),
    title: formData.get("title"),
    phase: formData.get("phase"),
    kind: formData.get("kind"),
    priority: formData.get("priority"),
    dueAt: formData.get("dueAt") ?? undefined,
    assigneeUserId: formData.get("assigneeUserId") ?? undefined,
    descriptionMd: formData.get("descriptionMd") ?? undefined,
  });

  await createTask(getDb(), session.organisationId, {
    clientId: v.clientId,
    title: v.title,
    phase: v.phase,
    kind: v.kind,
    priority: v.priority,
    dueAt: v.dueAt ? new Date(`${v.dueAt}T17:00:00.000Z`) : undefined,
    assigneeUserId: v.assigneeUserId && v.assigneeUserId.length > 0 ? v.assigneeUserId : undefined,
    descriptionMd: v.descriptionMd && v.descriptionMd.length > 0 ? v.descriptionMd : undefined,
    actorKind: "user",
    actorId: session.userId,
  });

  revalidatePath("/tasks");
  revalidatePath("/");
}

const StatusForm = z.object({
  taskId: z.string().uuid(),
  status: z.enum(schema.taskStatusEnum.enumValues),
});

export async function updateTaskStatusAction(formData: FormData) {
  const session = await requireAdmin();
  const v = StatusForm.parse({ taskId: formData.get("taskId"), status: formData.get("status") });
  const { task } = await updateTaskStatus(getDb(), session.organisationId, {
    taskId: v.taskId, status: v.status, actorKind: "user", actorId: session.userId,
  });
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${v.taskId}`);
  revalidatePath(`/clients/${task.clientId}/tasks`);
  revalidatePath("/");
}
```
A date-only input has no time; `17:00Z` is used so a task due "today" is not already overdue at 00:01.

- [ ] **Step 4: `apps/web/src/app/(admin)/tasks/task-filters.tsx`**

A plain GET form — no client JavaScript, filters live in the URL and are shareable.
```tsx
import { schema } from "@launchos/db";
import { Button } from "@/components/ui/button";

type Option = { value: string; label: string };

export function TaskFilterBar({
  clients, members, current,
}: {
  clients: Option[];
  members: Option[];
  current: Record<string, string | undefined>;
}) {
  const selects: { name: string; label: string; options: Option[] }[] = [
    { name: "client", label: "Client", options: clients },
    { name: "assignee", label: "Assignee", options: [{ value: "unassigned", label: "Unassigned" }, ...members] },
    { name: "phase", label: "Phase", options: schema.taskPhaseEnum.enumValues.map((v) => ({ value: v, label: v })) },
    { name: "kind", label: "Kind", options: schema.taskKindEnum.enumValues.map((v) => ({ value: v, label: v })) },
    { name: "status", label: "Status", options: schema.taskStatusEnum.enumValues.map((v) => ({ value: v, label: v.replaceAll("_", " ") })) },
  ];

  return (
    <form method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-3">
      <input type="hidden" name="view" value={current.view ?? "list"} />
      {selects.map((s) => (
        <label key={s.name} className="flex flex-col gap-1 text-xs text-neutral-500">
          {s.label}
          <select
            name={s.name}
            defaultValue={current[s.name] ?? ""}
            className="h-9 min-w-40 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900"
          >
            <option value="">Any</option>
            {s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      ))}
      <label className="flex flex-col gap-1 text-xs text-neutral-500">
        Due from
        <input type="date" name="dueFrom" defaultValue={current.dueFrom ?? ""} className="h-9 rounded-md border border-neutral-300 px-2 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-500">
        Due to
        <input type="date" name="dueTo" defaultValue={current.dueTo ?? ""} className="h-9 rounded-md border border-neutral-300 px-2 text-sm" />
      </label>
      <Button type="submit" variant="outline">Apply</Button>
    </form>
  );
}
```

- [ ] **Step 5: `apps/web/src/app/(admin)/tasks/task-row-status.tsx`**

One reusable status changer used by both the list and the board — a select plus a submit button, no drag library.
```tsx
import { schema } from "@launchos/db";
import { updateTaskStatusAction } from "./actions";

export function TaskStatusForm({ taskId, status }: { taskId: string; status: string }) {
  return (
    <form action={updateTaskStatusAction} className="flex items-center gap-1">
      <input type="hidden" name="taskId" value={taskId} />
      <select
        name="status"
        defaultValue={status}
        aria-label="Status"
        className="h-8 rounded-md border border-neutral-300 bg-white px-1.5 text-xs text-neutral-900"
      >
        {schema.taskStatusEnum.enumValues.map((v) => (
          <option key={v} value={v}>{v.replaceAll("_", " ")}</option>
        ))}
      </select>
      <button type="submit" className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100">
        Move
      </button>
    </form>
  );
}
```

- [ ] **Step 6: `apps/web/src/app/(admin)/tasks/task-board.tsx`**

```tsx
import type { TaskListRow } from "@launchos/core";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import { TaskStatusForm } from "./task-row-status";

const COLUMNS = ["todo", "in_progress", "blocked", "review", "done"] as const;

export function TaskBoard({ tasks }: { tasks: TaskListRow[] }) {
  return (
    <div className="grid gap-3 overflow-x-auto md:grid-cols-2 xl:grid-cols-5">
      {COLUMNS.map((column) => {
        const cards = tasks.filter((t) => t.status === column);
        return (
          <section key={column} className="min-w-56 rounded-lg border border-neutral-200 bg-neutral-50 p-2">
            <header className="mb-2 flex items-center justify-between px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{column.replaceAll("_", " ")}</h2>
              <span className="text-xs tabular-nums text-neutral-400">{cards.length}</span>
            </header>
            <div className="space-y-2">
              {cards.map((task) => (
                <article key={task.id} className="rounded-md border border-neutral-200 bg-white p-2.5">
                  <Link href={`/tasks/${task.id}`} className="block text-sm font-medium text-neutral-900 hover:underline">
                    {task.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-neutral-500">{task.clientName}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <StatusBadge value={task.priority} />
                    <StatusBadge value={task.phase} />
                  </div>
                  <p className="mt-2 text-xs text-neutral-500">
                    {task.dueAt ? `Due ${formatDateTime(task.dueAt)}` : "No due date"}
                    {task.assigneeName ? ` · ${task.assigneeName}` : " · Unassigned"}
                  </p>
                  <div className="mt-2"><TaskStatusForm taskId={task.id} status={task.status} /></div>
                </article>
              ))}
              {cards.length === 0 ? <p className="px-1 py-4 text-center text-xs text-neutral-400">Nothing here</p> : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
```
`cancelled` is deliberately absent from the board — cancelled work is visible in the list view but does not deserve a column.

- [ ] **Step 7: `apps/web/src/app/(admin)/tasks/new-task-dialog.tsx`**

```tsx
"use client";

import { useState } from "react";
import { schema } from "@launchos/db";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createTaskAction } from "./actions";

type Option = { value: string; label: string };

const FIELD = "h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";

export function NewTaskDialog({ clients, members, defaultClientId }: { clients: Option[]; members: Option[]; defaultClientId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button>New task</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>New task</DialogTitle></DialogHeader>
        <form action={async (formData) => { await createTaskAction(formData); setOpen(false); }} className="space-y-3">
          <label className="block text-xs text-neutral-500">
            Client
            <select name="clientId" required defaultValue={defaultClientId ?? ""} className={FIELD}>
              <option value="" disabled>Choose a client</option>
              {clients.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label className="block text-xs text-neutral-500">
            Title
            <input name="title" required maxLength={200} className={FIELD} placeholder="Write October blog post" />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="block text-xs text-neutral-500">
              Phase
              <select name="phase" defaultValue="support" className={FIELD}>
                {schema.taskPhaseEnum.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="block text-xs text-neutral-500">
              Kind
              <select name="kind" defaultValue="other" className={FIELD}>
                {schema.taskKindEnum.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="block text-xs text-neutral-500">
              Priority
              <select name="priority" defaultValue="medium" className={FIELD}>
                {schema.taskPriorityEnum.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-neutral-500">
              Due date
              <input type="date" name="dueAt" className={FIELD} />
            </label>
            <label className="block text-xs text-neutral-500">
              Assignee
              <select name="assigneeUserId" defaultValue="" className={FIELD}>
                <option value="">Unassigned</option>
                {members.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
          </div>
          <label className="block text-xs text-neutral-500">
            Description
            <textarea name="descriptionMd" rows={4} className="w-full rounded-md border border-neutral-300 bg-white p-2 text-sm" />
          </label>
          <DialogFooter>
            <Button type="submit">Create task</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 8: `apps/web/src/app/(admin)/tasks/page.tsx`**

```tsx
import { listMembers, listTasks, type TaskFilters } from "@launchos/core";
import { schema } from "@launchos/db";
import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { NewTaskDialog } from "./new-task-dialog";
import { TaskBoard } from "./task-board";
import { TaskFilterBar } from "./task-filters";
import { TaskStatusForm } from "./task-row-status";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const session = await requireAdmin();
  const sp = await searchParams;
  const view = one(sp.view) === "board" ? "board" : "list";

  const filters: TaskFilters = {
    clientId: one(sp.client),
    assigneeUserId: one(sp.assignee),
    phase: one(sp.phase) as TaskFilters["phase"],
    kind: one(sp.kind) as TaskFilters["kind"],
    status: one(sp.status) ? [one(sp.status) as NonNullable<TaskFilters["status"]>[number]] : undefined,
    dueFrom: one(sp.dueFrom) ? new Date(`${one(sp.dueFrom)}T00:00:00.000Z`) : undefined,
    dueTo: one(sp.dueTo) ? new Date(`${one(sp.dueTo)}T23:59:59.999Z`) : undefined,
  };

  const [tasks, clients, members] = await Promise.all([
    listTasks(getDb(), session.organisationId, filters),
    getDb().select({ id: schema.clients.id, name: schema.clients.name })
      .from(schema.clients).where(eq(schema.clients.organisationId, session.organisationId))
      .orderBy(asc(schema.clients.name)),
    listMembers(getDb(), session.organisationId),
  ]);

  const clientOptions = clients.map((c) => ({ value: c.id, label: c.name }));
  const memberOptions = members.map((m) => ({ value: m.userId, label: m.displayName ?? m.email }));
  const other = view === "board" ? "list" : "board";

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Onboarding, recurring service work and support tasks across every client."
        actions={
          <>
            <Link
              href={{ pathname: "/tasks", query: { ...sp, view: other } }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
            >
              {other === "board" ? "Board view" : "List view"}
            </Link>
            <NewTaskDialog clients={clientOptions} members={memberOptions} />
          </>
        }
      />

      <TaskFilterBar
        clients={clientOptions}
        members={memberOptions}
        current={{ view, client: one(sp.client), assignee: one(sp.assignee), phase: one(sp.phase), kind: one(sp.kind), status: one(sp.status), dueFrom: one(sp.dueFrom), dueTo: one(sp.dueTo) }}
      />

      {tasks.length === 0 ? (
        <EmptyState>No tasks match these filters. Create one, or give a client a package so onboarding generates its list.</EmptyState>
      ) : view === "board" ? (
        <TaskBoard tasks={tasks} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <Link href={`/tasks/${task.id}`} className="font-medium text-neutral-900 hover:underline">{task.title}</Link>
                    <span className="ml-2 text-xs text-neutral-400">{task.kind}</span>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    <Link href={`/clients/${task.clientId}/tasks`} className="hover:underline">{task.clientName}</Link>
                  </TableCell>
                  <TableCell><StatusBadge value={task.phase} /></TableCell>
                  <TableCell><StatusBadge value={task.priority} /></TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(task.dueAt)}</TableCell>
                  <TableCell className="text-neutral-600">{task.assigneeName ?? "Unassigned"}</TableCell>
                  <TableCell><TaskStatusForm taskId={task.id} status={task.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
```
`listMembers` returns `userId`, `displayName` and `email` per the Plan 2 contract; if its column names differ, map them here rather than changing the service.

- [ ] **Step 9: Enable the Tasks nav item**

In `apps/web/src/app/(admin)/layout.tsx`, change Plan 2's disabled entry `{ label: "Tasks" }` to `{ label: "Tasks", href: "/tasks" }`.

- [ ] **Step 10: Dashboard cards**

In `apps/web/src/app/(admin)/page.tsx`, add three counts to the existing `Promise.all` and three cards to the `cards` array. Add `and`, `count`, `eq`, `gte`, `isNotNull`, `isNull`, `lt`, `lte`, `notInArray` to the `drizzle-orm` import as needed.

Module constants, beside the existing `OPEN_TICKET_STATUSES`:
```tsx
const UNFINISHED_TASK_STATUSES = ["todo", "in_progress", "blocked", "review"] as const;
const FINISHED_TASK_STATUSES = ["done", "cancelled"] as const;
```
Inside the component, before the `Promise.all`:
```tsx
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * 86_400_000);
```
Three more entries in the `Promise.all`, destructured as `overdueTasks`, `dueThisWeek`, `onboarding`:
```tsx
    getDb().select({ value: count() }).from(schema.tasks).where(and(
      eq(schema.tasks.organisationId, org),
      isNotNull(schema.tasks.dueAt),
      lt(schema.tasks.dueAt, now),
      notInArray(schema.tasks.status, [...FINISHED_TASK_STATUSES]),
    )),
    getDb().select({ value: count() }).from(schema.tasks).where(and(
      eq(schema.tasks.organisationId, org),
      gte(schema.tasks.dueAt, now),
      lte(schema.tasks.dueAt, weekEnd),
      inArray(schema.tasks.status, [...UNFINISHED_TASK_STATUSES]),
    )),
    getDb().select({ value: count() }).from(schema.clients).where(and(
      eq(schema.clients.organisationId, org),
      isNotNull(schema.clients.packageId),
      isNull(schema.clients.onboardedAt),
    )),
```
Three more cards appended to the `cards` array:
```tsx
    { label: "Overdue tasks", value: overdueTasks[0]?.value ?? 0, href: "/tasks", hint: "Past their due date" },
    { label: "Due this week", value: dueThisWeek[0]?.value ?? 0, href: "/tasks", hint: "Next seven days" },
    { label: "Onboarding in progress", value: onboarding[0]?.value ?? 0, href: "/clients", hint: "Clients on a package, not handed over" },
```

- [ ] **Step 11: Verify by hand**

Run: `pnpm typecheck && pnpm dev`, sign in, open `/tasks`.
Expected: the page renders with the empty state (no packages seeded yet), the sidebar links to it, the filter bar and New task dialog open, and the dashboard shows three zeroed task cards.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(web): tasks list and board with filters, new task dialog, nav entry and dashboard cards"
```

---

### Task 11: Web — task detail, client Tasks tab, Settings → Packages and Task templates

**Files:**
- Create: `apps/web/src/app/(admin)/tasks/[id]/page.tsx`
- Create: `apps/web/src/app/(admin)/clients/[id]/tasks/page.tsx`, `apps/web/src/app/(admin)/clients/[id]/tasks/actions.ts`
- Create: `apps/web/src/components/progress-bar.tsx`
- Create: `apps/web/src/app/(admin)/settings/packages/page.tsx`, `actions.ts`
- Create: `apps/web/src/app/(admin)/settings/task-templates/page.tsx`, `actions.ts`
- Modify: `apps/web/src/app/(admin)/tasks/actions.ts`, `apps/web/src/app/(admin)/clients/[id]/layout.tsx`, `apps/web/src/app/(admin)/clients/new-client-dialog.tsx`, `apps/web/src/app/(admin)/clients/actions.ts`, `apps/web/src/app/(admin)/layout.tsx`

**Interfaces:**
- Produces: routes `/tasks/[id]`, `/clients/[id]/tasks`, `/settings/packages`, `/settings/task-templates`; server actions `assignTaskAction`, `commentOnTaskAction`, `toggleChecklistAction`, `setTaskVisibilityAction` (in `tasks/actions.ts`), `regenerateOnboardingAction` (in `clients/[id]/tasks/actions.ts`), `createPackageAction` / `updatePackageAction`, `createTemplateAction` / `updateTemplateAction` / `deleteTemplateAction`.
- Consumes: `getTask`, `listTasks`, `assignTask`, `commentOnTask`, `toggleChecklistItem`, `setTaskVisibility`, `generateOnboardingTasks`, `listPackages`, `createPackage`, `updatePackage`, `listTaskTemplates`, `createTaskTemplate`, `updateTaskTemplate`, `deleteTaskTemplate`, `listMembers`.

- [ ] **Step 1: Extend `apps/web/src/app/(admin)/tasks/actions.ts`**

Add to the existing file (keeping `createTaskAction` and `updateTaskStatusAction`):
```ts
import { assignTask, commentOnTask, setTaskVisibility, toggleChecklistItem } from "@launchos/core";

const AssignForm = z.object({ taskId: z.string().uuid(), assigneeUserId: z.string().trim() });

export async function assignTaskAction(formData: FormData) {
  const session = await requireAdmin();
  const v = AssignForm.parse({ taskId: formData.get("taskId"), assigneeUserId: formData.get("assigneeUserId") ?? "" });
  await assignTask(getDb(), session.organisationId, {
    taskId: v.taskId,
    assigneeUserId: v.assigneeUserId.length > 0 ? v.assigneeUserId : null,
    actorKind: "user", actorId: session.userId,
  });
  revalidatePath(`/tasks/${v.taskId}`);
  revalidatePath("/tasks");
}

const CommentForm = z.object({ taskId: z.string().uuid(), bodyMd: z.string().trim().min(1).max(10000) });

export async function commentOnTaskAction(formData: FormData) {
  const session = await requireAdmin();
  const v = CommentForm.parse({ taskId: formData.get("taskId"), bodyMd: formData.get("bodyMd") });
  await commentOnTask(getDb(), session.organisationId, {
    taskId: v.taskId, bodyMd: v.bodyMd, authorKind: "user", authorId: session.userId,
  });
  revalidatePath(`/tasks/${v.taskId}`);
}

const ChecklistForm = z.object({
  taskId: z.string().uuid(),
  index: z.coerce.number().int().min(0).max(49),
  done: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function toggleChecklistAction(formData: FormData) {
  const session = await requireAdmin();
  const v = ChecklistForm.parse({ taskId: formData.get("taskId"), index: formData.get("index"), done: formData.get("done") });
  await toggleChecklistItem(getDb(), session.organisationId, { taskId: v.taskId, index: v.index, done: v.done });
  revalidatePath(`/tasks/${v.taskId}`);
}

const VisibilityForm = z.object({
  taskId: z.string().uuid(),
  clientVisible: z.enum(["true", "false"]).transform((v) => v === "true"),
  redirectTo: z.string().trim().optional(),
});

export async function setTaskVisibilityAction(formData: FormData) {
  const session = await requireAdmin();
  const v = VisibilityForm.parse({
    taskId: formData.get("taskId"),
    clientVisible: formData.get("clientVisible"),
    redirectTo: formData.get("redirectTo") ?? undefined,
  });
  const task = await setTaskVisibility(getDb(), session.organisationId, {
    taskId: v.taskId, clientVisible: v.clientVisible, actorKind: "user", actorId: session.userId,
  });
  revalidatePath(`/tasks/${v.taskId}`);
  revalidatePath(`/clients/${task.clientId}/tasks`);
}
```

- [ ] **Step 2: `apps/web/src/app/(admin)/tasks/[id]/page.tsx`**

```tsx
import { getTask, listMembers } from "@launchos/core";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { assignTaskAction, commentOnTaskAction, setTaskVisibilityAction, toggleChecklistAction } from "../actions";
import { TaskStatusForm } from "../task-row-status";

export const dynamic = "force-dynamic";

export default async function TaskDetailPage({ params }: PageProps<"/tasks/[id]">) {
  const session = await requireAdmin();
  const { id } = await params;
  const loaded = await getTask(getDb(), session.organisationId, id);
  if (!loaded) notFound();
  const { task, comments } = loaded;

  const [[client], members] = await Promise.all([
    getDb().select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, task.clientId)),
    listMembers(getDb(), session.organisationId),
  ]);

  return (
    <>
      <PageHeader
        title={task.title}
        description={`${task.phase} · ${task.kind} · ${client?.name ?? "Unknown client"}`}
        actions={<TaskStatusForm taskId={task.id} status={task.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Description</h2>
            {task.descriptionMd ? (
              <div className="prose prose-sm max-w-none text-neutral-700"><ReactMarkdown>{task.descriptionMd}</ReactMarkdown></div>
            ) : (
              <p className="text-sm text-neutral-400">No description.</p>
            )}
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Checklist</h2>
            {task.checklist.length === 0 ? (
              <p className="text-sm text-neutral-400">No checklist on this task.</p>
            ) : (
              <ul className="space-y-1.5">
                {task.checklist.map((item, index) => (
                  <li key={`${item.label}-${index}`} className="flex items-center gap-2">
                    <form action={toggleChecklistAction}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="index" value={index} />
                      <input type="hidden" name="done" value={item.done ? "false" : "true"} />
                      <button type="submit" aria-label={item.done ? `Undo ${item.label}` : `Complete ${item.label}`}
                        className="flex h-5 w-5 items-center justify-center rounded border border-neutral-300 text-xs text-neutral-700 hover:bg-neutral-100">
                        {item.done ? "x" : ""}
                      </button>
                    </form>
                    <span className={item.done ? "text-sm text-neutral-400 line-through" : "text-sm text-neutral-800"}>{item.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Comments</h2>
            <ul className="mb-3 space-y-3">
              {comments.map((c) => (
                <li key={c.id} className="rounded-md bg-neutral-50 p-3">
                  <p className="text-xs text-neutral-500">{c.authorKind} · {formatDateTime(c.createdAt)}</p>
                  <div className="prose prose-sm mt-1 max-w-none text-neutral-800"><ReactMarkdown>{c.bodyMd}</ReactMarkdown></div>
                </li>
              ))}
              {comments.length === 0 ? <li className="text-sm text-neutral-400">No comments yet.</li> : null}
            </ul>
            <form action={commentOnTaskAction} className="space-y-2">
              <input type="hidden" name="taskId" value={task.id} />
              <textarea name="bodyMd" rows={3} required aria-label="Comment"
                className="w-full rounded-md border border-neutral-300 p-2 text-sm" placeholder="Add a comment" />
              <Button type="submit" variant="outline">Add comment</Button>
            </form>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4 text-sm">
            <h2 className="text-sm font-semibold text-neutral-900">Details</h2>
            <p className="flex justify-between"><span className="text-neutral-500">Status</span><StatusBadge value={task.status} /></p>
            <p className="flex justify-between"><span className="text-neutral-500">Priority</span><StatusBadge value={task.priority} /></p>
            <p className="flex justify-between"><span className="text-neutral-500">Due</span><span className="text-neutral-800">{formatDateTime(task.dueAt)}</span></p>
            <p className="flex justify-between"><span className="text-neutral-500">Completed</span><span className="text-neutral-800">{formatDateTime(task.completedAt)}</span></p>
            <p className="flex justify-between">
              <span className="text-neutral-500">Client</span>
              <Link href={`/clients/${task.clientId}/tasks`} className="text-neutral-900 hover:underline">{client?.name ?? "—"}</Link>
            </p>
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Assignee</h2>
            <form action={assignTaskAction} className="flex items-center gap-2">
              <input type="hidden" name="taskId" value={task.id} />
              <select name="assigneeUserId" defaultValue={task.assigneeUserId ?? ""} aria-label="Assignee"
                className="h-9 flex-1 rounded-md border border-neutral-300 bg-white px-2 text-sm">
                <option value="">Unassigned</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName ?? m.email}</option>)}
              </select>
              <Button type="submit" variant="outline">Save</Button>
            </form>
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Client portal</h2>
            <p className="mb-2 text-sm text-neutral-600">{task.clientVisible ? "Visible to the client." : "Hidden from the client."}</p>
            <form action={setTaskVisibilityAction}>
              <input type="hidden" name="taskId" value={task.id} />
              <input type="hidden" name="clientVisible" value={task.clientVisible ? "false" : "true"} />
              <Button type="submit" variant="outline">{task.clientVisible ? "Hide from client" : "Show to client"}</Button>
            </form>
          </section>
        </aside>
      </div>
    </>
  );
}
```

- [ ] **Step 3: `apps/web/src/components/progress-bar.tsx`**

```tsx
export function ProgressBar({ label, done, total }: { label: string; done: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium text-neutral-700">{label}</span>
        <span className="tabular-nums text-neutral-500">{done} of {total} · {percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200" role="progressbar"
        aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `apps/web/src/app/(admin)/clients/[id]/tasks/actions.ts`**

```ts
"use server";

import { generateOnboardingTasks } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const Form = z.object({ clientId: z.string().uuid() });

/**
 * Runs the same idempotent generator the `tasks.generate-onboarding` worker job
 * runs. Useful after changing a client's package, adding a template, or when
 * the worker was not running at the moment the client was created.
 */
export async function regenerateOnboardingAction(formData: FormData) {
  const session = await requireAdmin();
  const { clientId } = Form.parse({ clientId: formData.get("clientId") });
  await generateOnboardingTasks(getDb(), session.organisationId, clientId);
  revalidatePath(`/clients/${clientId}/tasks`);
  revalidatePath("/tasks");
}
```

- [ ] **Step 5: `apps/web/src/app/(admin)/clients/[id]/tasks/page.tsx`**

```tsx
import { listMembers, listTasks } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/page-header";
import { ProgressBar } from "@/components/progress-bar";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { NewTaskDialog } from "../../../tasks/new-task-dialog";
import { setTaskVisibilityAction } from "../../../tasks/actions";
import { TaskStatusForm } from "../../../tasks/task-row-status";
import { regenerateOnboardingAction } from "./actions";

export const dynamic = "force-dynamic";

const FINISHED = new Set(["done", "cancelled"]);

export default async function ClientTasksPage({ params }: PageProps<"/clients/[id]/tasks">) {
  const session = await requireAdmin();
  const { id } = await params;

  const [client] = await getDb().select().from(schema.clients)
    .where(and(eq(schema.clients.id, id), eq(schema.clients.organisationId, session.organisationId)));
  if (!client) notFound();

  const [tasks, members] = await Promise.all([
    listTasks(getDb(), session.organisationId, { clientId: id }),
    listMembers(getDb(), session.organisationId),
  ]);

  const progress = (phase: "onboarding" | "recurring") => {
    const rows = tasks.filter((t) => t.phase === phase);
    return { done: rows.filter((t) => FINISHED.has(t.status)).length, total: rows.length };
  };
  const onboarding = progress("onboarding");
  const recurring = progress("recurring");

  return (
    <div className="space-y-4">
      <section className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-4 sm:grid-cols-2">
        <ProgressBar label="Onboarding" done={onboarding.done} total={onboarding.total} />
        <ProgressBar label="Recurring service work" done={recurring.done} total={recurring.total} />
        <p className="text-xs text-neutral-500 sm:col-span-2">
          Onboarded {formatDateTime(client.onboardedAt)} · Handed over {formatDateTime(client.handoverAt)}
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <NewTaskDialog
          clients={[{ value: client.id, label: client.name }]}
          members={members.map((m) => ({ value: m.userId, label: m.displayName ?? m.email }))}
          defaultClientId={client.id}
        />
        <form action={regenerateOnboardingAction}>
          <input type="hidden" name="clientId" value={client.id} />
          <Button type="submit" variant="outline">Generate onboarding tasks</Button>
        </form>
      </div>

      {tasks.length === 0 ? (
        <EmptyState>
          No tasks yet. Give this client a package in Settings, then use “Generate onboarding tasks”.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Client sees</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <Link href={`/tasks/${task.id}`} className="font-medium text-neutral-900 hover:underline">{task.title}</Link>
                  </TableCell>
                  <TableCell><StatusBadge value={task.phase} /></TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(task.dueAt)}</TableCell>
                  <TableCell className="text-neutral-600">{task.assigneeName ?? "Unassigned"}</TableCell>
                  <TableCell>
                    <form action={setTaskVisibilityAction}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="clientVisible" value={task.clientVisible ? "false" : "true"} />
                      <button type="submit" className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100">
                        {task.clientVisible ? "Visible" : "Hidden"}
                      </button>
                    </form>
                  </TableCell>
                  <TableCell><TaskStatusForm taskId={task.id} status={task.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Add the Tasks tab and the package select**

In `apps/web/src/app/(admin)/clients/[id]/layout.tsx`, add `{ label: "Tasks", href: \`/clients/${id}/tasks\` }` to Plan 2's tab array, after "Sites & Domains".

In `apps/web/src/app/(admin)/clients/new-client-dialog.tsx`, add a `packages: { value: string; label: string }[]` prop and this field before the submit button:
```tsx
          <label className="block text-xs text-neutral-500">
            Package
            <select name="packageId" defaultValue="" className={FIELD}>
              <option value="">No package</option>
              {packages.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
```
In the page that renders the dialog (`apps/web/src/app/(admin)/clients/page.tsx`), pass `packages={(await listPackages(getDb(), session.organisationId, { activeOnly: true })).map((p) => ({ value: p.id, label: p.name }))}`.

In `apps/web/src/app/(admin)/clients/actions.ts`, add `packageId: z.string().uuid().optional().or(z.literal("").transform(() => undefined))` to Plan 2's form schema, read `formData.get("packageId") ?? undefined`, and pass `packageId` through to `createClient`. If Plan 2's `createClient` does not yet accept `packageId`, add it to `CreateClientInput` as `z.string().uuid().optional()` and write it into the insert — the column exists from migration 0003.

- [ ] **Step 7: Settings → Packages**

`apps/web/src/app/(admin)/settings/packages/actions.ts`:
```ts
"use server";

import { createPackage, updatePackage } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const Includes = z.object({
  website: z.coerce.boolean(),
  seo: z.coerce.boolean(),
  ads: z.coerce.boolean(),
  socialPostsPerMonth: z.coerce.number().int().min(0).max(60),
  blogPostsPerMonth: z.coerce.number().int().min(0).max(60),
  gbpUpdatesPerMonth: z.coerce.number().int().min(0).max(60),
});

const Base = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  monthlyPricePence: z.coerce.number().int().min(0),
  setupPricePence: z.coerce.number().int().min(0),
};

function readIncludes(formData: FormData) {
  return Includes.parse({
    website: formData.get("website") === "on",
    seo: formData.get("seo") === "on",
    ads: formData.get("ads") === "on",
    socialPostsPerMonth: formData.get("socialPostsPerMonth") ?? 0,
    blogPostsPerMonth: formData.get("blogPostsPerMonth") ?? 0,
    gbpUpdatesPerMonth: formData.get("gbpUpdatesPerMonth") ?? 0,
  });
}

const CreateForm = z.object({ ...Base, slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/) });

export async function createPackageAction(formData: FormData) {
  const session = await requireAdmin();
  const v = CreateForm.parse({
    name: formData.get("name"), slug: formData.get("slug"),
    description: formData.get("description") ?? undefined,
    monthlyPricePence: formData.get("monthlyPricePence") ?? 0,
    setupPricePence: formData.get("setupPricePence") ?? 0,
  });
  await createPackage(getDb(), session.organisationId, { ...v, includes: readIncludes(formData), actorKind: "user", actorId: session.userId });
  revalidatePath("/settings/packages");
}

const UpdateForm = z.object({ ...Base, packageId: z.string().uuid(), active: z.boolean() });

export async function updatePackageAction(formData: FormData) {
  const session = await requireAdmin();
  const v = UpdateForm.parse({
    packageId: formData.get("packageId"), name: formData.get("name"),
    description: formData.get("description") ?? undefined,
    monthlyPricePence: formData.get("monthlyPricePence") ?? 0,
    setupPricePence: formData.get("setupPricePence") ?? 0,
    active: formData.get("active") === "on",
  });
  await updatePackage(getDb(), session.organisationId, { ...v, includes: readIncludes(formData), actorKind: "user", actorId: session.userId });
  revalidatePath("/settings/packages");
}
```

`apps/web/src/app/(admin)/settings/packages/page.tsx`: a `force-dynamic` server component calling `requireAdmin()` and `listPackages(getDb(), session.organisationId, {})`. It renders:
1. A "New package" card wrapping a `<form action={createPackageAction}>` with text inputs `name`, `slug`, `description`, number inputs `monthlyPricePence`, `setupPricePence`, `socialPostsPerMonth`, `blogPostsPerMonth`, `gbpUpdatesPerMonth`, and checkboxes `website`, `seo`, `ads`.
2. One `<form action={updatePackageAction}>` per existing package, each with a hidden `packageId`, the same fields pre-filled from the row (`defaultValue={pkg.includes.socialPostsPerMonth}` and so on), an `active` checkbox and a "Save" button.
Use `PageHeader title="Packages" description="What each retainer includes. Quantities drive recurring task generation."`.

- [ ] **Step 8: Settings → Task templates**

`apps/web/src/app/(admin)/settings/task-templates/actions.ts`:
```ts
"use server";

import { createTaskTemplate, deleteTaskTemplate, updateTaskTemplate } from "@launchos/core";
import { schema } from "@launchos/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const Fields = {
  packageId: z.string().trim(),
  phase: z.enum(schema.taskPhaseEnum.enumValues),
  kind: z.enum(schema.taskKindEnum.enumValues),
  title: z.string().trim().min(1).max(200),
  descriptionMd: z.string().trim().max(10000).optional(),
  offsetDays: z.coerce.number().int().min(0).max(365),
  recurrence: z.enum(schema.taskRecurrenceEnum.enumValues),
  defaultAssigneeRole: z.enum(schema.taskAssigneeRoleEnum.enumValues),
  sortOrder: z.coerce.number().int().min(0).max(10000),
  checklist: z.string().trim().max(4000).optional(),
};

function read(formData: FormData) {
  return z.object(Fields).parse({
    packageId: formData.get("packageId") ?? "",
    phase: formData.get("phase"),
    kind: formData.get("kind"),
    title: formData.get("title"),
    descriptionMd: formData.get("descriptionMd") ?? undefined,
    offsetDays: formData.get("offsetDays") ?? 0,
    recurrence: formData.get("recurrence") ?? "none",
    defaultAssigneeRole: formData.get("defaultAssigneeRole") ?? "any",
    sortOrder: formData.get("sortOrder") ?? 0,
    checklist: formData.get("checklist") ?? undefined,
  });
}

/** One checklist item per line in the textarea. */
function toChecklist(raw: string | undefined): string[] {
  return (raw ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

export async function createTemplateAction(formData: FormData) {
  const session = await requireAdmin();
  const v = read(formData);
  await createTaskTemplate(getDb(), session.organisationId, {
    ...v,
    packageId: v.packageId.length > 0 ? v.packageId : null,
    checklist: toChecklist(v.checklist),
    actorKind: "user", actorId: session.userId,
  });
  revalidatePath("/settings/task-templates");
}

export async function updateTemplateAction(formData: FormData) {
  const session = await requireAdmin();
  const templateId = z.string().uuid().parse(formData.get("templateId"));
  const v = read(formData);
  await updateTaskTemplate(getDb(), session.organisationId, {
    templateId, ...v,
    packageId: v.packageId.length > 0 ? v.packageId : null,
    checklist: toChecklist(v.checklist),
    actorKind: "user", actorId: session.userId,
  });
  revalidatePath("/settings/task-templates");
}

export async function deleteTemplateAction(formData: FormData) {
  const session = await requireAdmin();
  const templateId = z.string().uuid().parse(formData.get("templateId"));
  await deleteTaskTemplate(getDb(), session.organisationId, { templateId, actorKind: "user", actorId: session.userId });
  revalidatePath("/settings/task-templates");
}
```
`createTaskTemplate` and `updateTaskTemplate` both take `checklist` as `string[]`; the textarea is split on newlines so ordering is preserved.

`apps/web/src/app/(admin)/settings/task-templates/page.tsx`: a `force-dynamic` server component calling `requireAdmin()`, `listTaskTemplates(getDb(), session.organisationId, {})` and `listPackages(getDb(), session.organisationId, {})`. It renders one section per phase (`onboarding`, `recurring`, `support`), each a table whose rows are `<form action={updateTemplateAction}>` containing hidden `templateId`, a `title` text input, `package` select (blank = all packages), `kind`, `recurrence` and `defaultAssigneeRole` selects, `offsetDays` and `sortOrder` number inputs, a `checklist` textarea, a "Save" button, and a second single-button `<form action={deleteTemplateAction}>` with the hidden `templateId`. Reordering is editing `sortOrder` and saving — no drag library. Above the tables, a "New template" form with the same fields and `createTemplateAction`.

- [ ] **Step 9: Settings navigation**

In `apps/web/src/app/(admin)/layout.tsx`, add the two settings links beneath the existing Settings entry (or into Plan 2's settings sub-nav if it has one): `{ label: "Packages", href: "/settings/packages" }` and `{ label: "Task templates", href: "/settings/task-templates" }`.

- [ ] **Step 10: Verify by hand**

Run: `pnpm typecheck && pnpm dev`. Sign in, then:
1. `/settings/packages` — create "Website Care" with 1 blog and 2 GBP updates a month. It appears in the list with an editable form.
2. `/settings/task-templates` — create an onboarding template "Discovery call", offset 1, sort 10, and a recurring "Blog post" template, monthly.
3. `/clients` — create a client and pick the package in the dialog.
4. Open the client's Tasks tab, click "Generate onboarding tasks": "Discovery call" appears, onboarding progress reads 0 of 1.
5. Open the task: add a comment, tick a checklist item, assign yourself, hide it from the client, move it to `done`. Progress reads 1 of 1 and the client's "Onboarded" date fills in.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(web): task detail, client tasks tab with phase progress, package and template settings"
```

---

### Task 12: Seed, Playwright smoke and docs

**Files:**
- Modify: `packages/db/src/seed.ts`
- Create: `apps/web/tests/e2e/admin-tasks.spec.ts`
- Modify: `docs/MODULE_MAP.md`, `docs/DATA_MODEL.md`, `README.md`

**Interfaces:**
- Produces: seeded packages `website-care` and `website-seo-social`, ten onboarding templates, four recurring templates, both demo clients on a package with their onboarding tasks generated; Playwright spec `admin-tasks.spec.ts`.
- Consumes: nothing new. `packages/db` must not import `@launchos/core` (the dependency direction is `core → db`), so the seed inserts tasks directly using the same rules `generateOnboardingTasks` applies — the duplication is deliberate and small.

- [ ] **Step 1: Seed constants**

Add to `packages/db/src/seed.ts`, near `SEED_CLIENTS`:
```ts
const SEED_PACKAGES = [
  {
    slug: "website-care", name: "Website Care",
    description: "Hosting, maintenance and monthly content for a brochure site.",
    monthlyPricePence: 9900, setupPricePence: 49900,
    includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
  },
  {
    slug: "website-seo-social", name: "Website + SEO + Social",
    description: "Everything in Website Care plus SEO and four social posts a month.",
    monthlyPricePence: 29900, setupPricePence: 79900,
    includes: { website: true, seo: true, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
  },
] as const;

// Zero to handover, in the order Shoji actually works it. All global: every
// package starts the same way.
const ONBOARDING_TEMPLATES = [
  { title: "Discovery call", kind: "other", offsetDays: 1, sortOrder: 10, defaultAssigneeRole: "owner", checklist: ["Goals", "Competitors", "Deadline"] },
  { title: "Content collection", kind: "content", offsetDays: 3, sortOrder: 20, defaultAssigneeRole: "any", checklist: ["Logo", "Photos", "Copy", "Opening hours"] },
  { title: "Design approval", kind: "review", offsetDays: 7, sortOrder: 30, defaultAssigneeRole: "owner", checklist: [] },
  { title: "Build website", kind: "build", offsetDays: 14, sortOrder: 40, defaultAssigneeRole: "any", checklist: ["Home", "Services", "Contact form", "Mobile check"] },
  { title: "DNS and hosting setup", kind: "dns", offsetDays: 16, sortOrder: 50, defaultAssigneeRole: "owner", checklist: ["Nameservers", "SSL", "Coolify resource"] },
  { title: "Deploy to production", kind: "deploy", offsetDays: 18, sortOrder: 60, defaultAssigneeRole: "any", checklist: ["Deploy", "Uptime monitor", "Backups"] },
  { title: "SEO setup", kind: "seo", offsetDays: 20, sortOrder: 70, defaultAssigneeRole: "any", checklist: ["Titles and descriptions", "Sitemap", "Search Console"] },
  { title: "Google Business Profile setup", kind: "gbp", offsetDays: 21, sortOrder: 80, defaultAssigneeRole: "any", checklist: ["Claim listing", "Categories", "Photos"] },
  { title: "Review request", kind: "review", offsetDays: 25, sortOrder: 90, defaultAssigneeRole: "any", checklist: [] },
  { title: "Handover", kind: "handover", offsetDays: 28, sortOrder: 100, defaultAssigneeRole: "owner", checklist: ["Walkthrough call", "Logins handed over", "Support address shared"] },
] as const;

// Quantities come from the package's `includes`, not from these rows.
const RECURRING_TEMPLATES = [
  { title: "Social post", kind: "social", recurrence: "monthly", sortOrder: 10, packageSlug: "website-seo-social", checklist: ["Draft", "Image", "Schedule"] },
  { title: "Blog post", kind: "content", recurrence: "monthly", sortOrder: 20, packageSlug: null, checklist: ["Outline", "Draft", "Publish"] },
  { title: "Google Business Profile update", kind: "gbp", recurrence: "monthly", sortOrder: 30, packageSlug: null, checklist: [] },
  { title: "SEO audit", kind: "seo", recurrence: "quarterly", sortOrder: 40, packageSlug: "website-seo-social", checklist: ["Rankings", "Broken links", "Page speed"] },
] as const;

const CLIENT_PACKAGES: Record<string, string> = {
  "Grays CabLine": "website-seo-social",
  "Mobile PC Doctor": "website-care",
};
```

- [ ] **Step 2: Seed functions**

Add to `packages/db/src/seed.ts`:
```ts
async function seedPackages(db: Db, organisationId: string) {
  const bySlug = new Map<string, typeof schema.packages.$inferSelect>();
  for (const spec of SEED_PACKAGES) {
    const [existing] = await db.select().from(schema.packages)
      .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.slug, spec.slug)));
    if (existing) { bySlug.set(spec.slug, existing); continue; }
    const [created] = await db.insert(schema.packages).values({ organisationId, ...spec }).returning();
    bySlug.set(spec.slug, created!);
  }
  return bySlug;
}

async function seedTaskTemplates(db: Db, organisationId: string, packagesBySlug: Map<string, typeof schema.packages.$inferSelect>) {
  const rows = [
    ...ONBOARDING_TEMPLATES.map((t) => ({ ...t, phase: "onboarding" as const, recurrence: "none" as const, packageId: null })),
    ...RECURRING_TEMPLATES.map((t) => ({
      title: t.title, kind: t.kind, sortOrder: t.sortOrder, checklist: t.checklist,
      phase: "recurring" as const, recurrence: t.recurrence, offsetDays: 0,
      defaultAssigneeRole: "any" as const,
      packageId: t.packageSlug ? packagesBySlug.get(t.packageSlug)!.id : null,
    })),
  ];

  let created = 0;
  for (const row of rows) {
    const [existing] = await db.select().from(schema.taskTemplates).where(and(
      eq(schema.taskTemplates.organisationId, organisationId),
      eq(schema.taskTemplates.phase, row.phase),
      eq(schema.taskTemplates.title, row.title),
    ));
    if (existing) continue;
    await db.insert(schema.taskTemplates).values({
      organisationId, packageId: row.packageId, phase: row.phase, kind: row.kind, title: row.title,
      offsetDays: row.offsetDays ?? 0, recurrence: row.recurrence,
      defaultAssigneeRole: row.defaultAssigneeRole, sortOrder: row.sortOrder, checklist: [...row.checklist],
    });
    created += 1;
  }
  return created;
}

async function assignPackage(db: Db, organisationId: string, client: typeof schema.clients.$inferSelect, packageId: string) {
  if (client.packageId === packageId) return client;
  const [updated] = await db.update(schema.clients)
    .set({ packageId, updatedAt: new Date() })
    .where(and(eq(schema.clients.id, client.id), eq(schema.clients.organisationId, organisationId)))
    .returning();
  return updated!;
}

/**
 * Mirrors generateOnboardingTasks. `packages/db` cannot import `@launchos/core`
 * (dependency direction is core → db), so the rules live twice: due date is
 * client.created_at + offset_days, owner-role templates go to the owner, and
 * (client_id, template_id) makes it idempotent.
 */
async function seedOnboardingTasks(db: Db, organisationId: string, clientId: string, createdAt: Date, ownerUserId: string) {
  const templates = await db.select().from(schema.taskTemplates).where(and(
    eq(schema.taskTemplates.organisationId, organisationId),
    eq(schema.taskTemplates.phase, "onboarding"),
  )).orderBy(asc(schema.taskTemplates.sortOrder));

  let created = 0;
  for (const template of templates) {
    const [existing] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
      eq(schema.tasks.clientId, clientId),
      eq(schema.tasks.templateId, template.id),
    ));
    if (existing) continue;
    await db.insert(schema.tasks).values({
      organisationId, clientId, templateId: template.id, phase: "onboarding", kind: template.kind,
      title: template.title, descriptionMd: template.descriptionMd,
      dueAt: new Date(createdAt.getTime() + template.offsetDays * 86_400_000),
      assigneeUserId: template.defaultAssigneeRole === "owner" ? ownerUserId : null,
      checklist: template.checklist.map((label) => ({ label, done: false })),
      createdByKind: "system",
    });
    created += 1;
  }
  return created;
}
```
Add `asc` to the existing `drizzle-orm` import in the seed.

- [ ] **Step 3: Call them from `main()`**

Before the existing `for (const spec of SEED_CLIENTS)` loop, after `seedAgentEnablement`:
```ts
    const packagesBySlug = await seedPackages(db, organisation.id);
    const templateCount = await seedTaskTemplates(db, organisation.id, packagesBySlug);
    console.log("packages      ", [...packagesBySlug.keys()].join(", "));
    console.log("templates     ", `${templateCount} created`);
```
and inside the loop, after `seedMonitor`:
```ts
      const withPackage = await assignPackage(db, organisation.id, client, packagesBySlug.get(CLIENT_PACKAGES[spec.name]!)!.id);
      const taskCount = await seedOnboardingTasks(db, organisation.id, withPackage.id, withPackage.createdAt, user.id);
      console.log("  package     ", withPackage.packageId);
      console.log("  tasks       ", `${taskCount} onboarding tasks created`);
```

- [ ] **Step 4: Run the seed**

Run: `pnpm db:migrate && pnpm db:seed`
Expected: two packages, 14 templates on the first run, and 10 onboarding tasks per client. Run it a second time: 0 templates and 0 tasks created, no error.

- [ ] **Step 5: Playwright smoke**

`apps/web/tests/e2e/admin-tasks.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? "shujaat@nexusedu.co.uk";
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "change-me-now";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

test.describe("tasks", () => {
  test("a client created with a package gets its onboarding task list", async ({ page }) => {
    await signIn(page);
    const name = `Playwright Client ${Date.now()}`;

    await page.goto("/clients");
    await page.getByRole("button", { name: "New client" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Package").selectOption({ label: "Website Care" });
    await page.getByRole("button", { name: /create client/i }).click();

    await page.getByRole("link", { name }).click();
    await page.getByRole("link", { name: "Tasks" }).click();

    // The worker's tasks.generate-onboarding job does this on client.created;
    // the button runs the same idempotent generator so the test does not need
    // a live worker. Clicking it when the job already ran is a no-op.
    await page.getByRole("button", { name: "Generate onboarding tasks" }).click();

    await expect(page.getByRole("link", { name: "Discovery call" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Handover" })).toBeVisible();
    await expect(page.getByText(/Onboarding/)).toBeVisible();
  });

  test("status changes move a task on the board", async ({ page }) => {
    await signIn(page);
    await page.goto("/tasks?view=board");
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

    await page.goto("/tasks");
    const row = page.getByRole("row").filter({ hasText: "Discovery call" }).first();
    await row.getByLabel("Status").selectOption("in_progress");
    await row.getByRole("button", { name: "Move" }).click();

    await page.goto("/tasks?view=board&status=in_progress");
    await expect(page.getByText("Discovery call").first()).toBeVisible();
  });
});
```

- [ ] **Step 6: Vitest for the recurring generator through the same seed data**

The cron itself is not exercised by Playwright. Add this case to `packages/core/src/tasks/generate-recurring-tasks.test.ts`, matching the spec's acceptance ("recurring generation job creates monthly social/blog/GBP tasks idempotently"):
```ts
  it("creates the seeded monthly mix for a Website + SEO + Social client", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db); // package includes 4 social, 1 blog, 2 GBP
      await createTaskTemplate(db, organisationId, { phase: "recurring", kind: "social", title: "Social post", recurrence: "monthly" });
      await createTaskTemplate(db, organisationId, { phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly" });
      await createTaskTemplate(db, organisationId, { phase: "recurring", kind: "gbp", title: "Google Business Profile update", recurrence: "monthly" });
      expect(await generateRecurringTasks(db, organisationId, { now: NOW })).toEqual({ created: 7, skipped: 0 });
      expect(await generateRecurringTasks(db, organisationId, { now: NOW })).toEqual({ created: 0, skipped: 7 });
      expect(await listTasks(db, organisationId, { clientId, kind: "social" })).toHaveLength(4);
      expect(await listTasks(db, organisationId, { clientId, kind: "gbp" })).toHaveLength(2);
    });
  });
```

- [ ] **Step 7: Run the whole suite**

Run: `pnpm db:up && pnpm db:migrate && pnpm db:seed && pnpm test && pnpm typecheck`
Expected: PASS.

Run `pnpm dev` in one terminal, then `pnpm --filter @launchos/web e2e`.
Expected: both specs pass. The existing `admin-incidents.spec.ts` still passes.

- [ ] **Step 8: Docs**

`docs/MODULE_MAP.md` — add to the admin table:

| Route | Module | v1 | Reads | Writes |
|---|---|---|---|---|
| `/tasks`, `/tasks/[id]` | Tasks | yes | tasks, clients, members, comments | create, status, assign, comment, checklist, visibility |
| `/clients/[id]/tasks` | Client tasks tab | yes | tasks for one client, phase progress | status, visibility, regenerate onboarding |
| `/settings/packages` | Packages | yes | packages | create, edit, archive |
| `/settings/task-templates` | Task templates | yes | task_templates, packages | create, edit, reorder, delete |

`docs/DATA_MODEL.md` — add two sections after `clients.ts`:
```
## packages.ts
- `packages`: `name`, `slug` unique per organisation, `description`, `monthly_price_pence`, `setup_price_pence`, `currency` (default `GBP`), `includes jsonb` (`website`, `seo`, `ads`, `socialPostsPerMonth`, `blogPostsPerMonth`, `gbpUpdatesPerMonth`), `active`.
- `task_templates`: `package_id?` (null = every package), `phase` (`onboarding|recurring|support`), `kind` (`build|deploy|dns|seo|content|social|gbp|review|handover|support|billing|other`), `title`, `description_md?`, `offset_days`, `recurrence` (`none|weekly|monthly|quarterly`), `default_assignee_role` (`owner|staff|any`), `sort_order`, `checklist jsonb` (string[]).

## tasks.ts
- `tasks`: `client_id`, `site_id?`, `template_id?`, `phase`, `kind`, `title`, `description_md?`, `status` (`todo|in_progress|blocked|review|done|cancelled`), `priority` (`low|medium|high|urgent`), `due_at?`, `assignee_user_id?`, `created_by_kind`, `created_by_id?`, `completed_at?`, `ticket_id?`, `recurrence_key?`, `checklist jsonb` (`{ label, done }[]`), `client_visible`. Unique `(client_id, template_id)` where the task is onboarding; unique `(client_id, recurrence_key)`; indexes on `(organisation_id, status, due_at)` and `(organisation_id, client_id, phase)`.
- `task_comments`: `task_id`, `author_kind`, `author_id?`, `body_md`.
- `clients` additions: `package_id` FK to `packages`, `onboarded_at?`, `handover_at?`.
```
Also update the relationship diagram's `clients` branch to include `tasks ── task_comments`.

`README.md` — in the Status section, add a Plan 3 bullet list:
```
**Plan 3 is implemented**: packages and task templates, automatic onboarding task generation on client creation, daily recurring service generation from package quantities, overdue chasing, a Tasks list and board, per-client task progress and Settings screens for the catalogue.
```
and remove "tasks" from the "Later (from the prototype)" line in `docs/MODULE_MAP.md`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: seed packages, templates and onboarding tasks; tasks e2e smoke; docs for the task engine"
```

---

## Self-review

- **Spec coverage.** §1 row P3 (packages and service catalogue, templates, tasks with statuses/assignee/due/comments/checklists, automatic generation on creation and on schedule, Tasks board and list, per-client and per-site task views, client-visible progress) is covered by Tasks 1–12. §3 P3 data model: every column named in the spec exists in Task 1, with `recurrence_key` shaped exactly as the spec's `social:2026-10` example. §4 "Client creation": `client.created` → `tasks.generate-onboarding` (Task 9), templates filtered `package_id IS NULL OR = client.package_id AND phase = onboarding`, due = created + `offset_days`, owner role → Shoji, `any` → unassigned (Task 6), `onboarded_at` and `handover_at` (Task 4). §4 "Recurring service generation": cron 06:00 Europe/London, per active client with a package, keyed on `recurrence_key`, quantities from `packages.includes` (Tasks 7 and 9). §5 nav: Tasks enabled and the client detail Tasks tab added (Tasks 10 and 11). §7 P3 acceptance: creating a client with a package generates the onboarding list, drag-free status change via select-and-button, idempotent recurring generation, client-visible tasks on the client's Tasks tab.
- **Per-site task views.** `tasks.site_id` exists and `listTasks` accepts a `siteId` filter, so a Plan 4 site page can list a site's tasks without a schema change. No site page is built here because Plan 2 owns `/sites/[id]`.
- **Placeholders.** None. Every symbol used is either defined in an earlier task of this plan, exists in the codebase today (`withTestDb`, `getDb`, `requireAdmin`, `recordAudit`, `schema.*`, `QUEUE`, `createBoss`, `setEnqueue`, `PageHeader`, `EmptyState`, `StatusBadge`, `formatDateTime`), or is listed in the Plan 2 interface table with its exact shape.
- **Ambiguities resolved.** (1) The spec writes `includes` keys in snake_case; they are stored camelCase because the value is a TypeScript object, not a column set — noted in `packages.ts`. (2) The spec's `recurrence_key` example `social:2026-10:1` is unique only within a client, so the unique index is `(client_id, recurrence_key)` rather than `(organisation_id, recurrence_key)`. (3) The brief writes `notify`/`notifyOwner` with one signature; `notify` needs a target, so this plan consumes `notify(db, organisationId, { userId, ... })` and `notifyOwner(db, organisationId, { ... })`, stated in the Plan 2 interface table. (4) Templates with `default_assignee_role: "staff"` are unspecified in the spec (it names only `owner` and `any`); they route through `pickLeastLoadedStaff`, which P4 reuses. (5) The Playwright acceptance clicks "Generate onboarding tasks" rather than waiting on the worker: the button calls the same `generateOnboardingTasks` the job calls, and the `client.created` → job mapping is covered by `apps/worker/src/jobs/task-generation.test.ts`, so the flow is proven end to end without an e2e dependency on a second long-lived process.
- **Type consistency.** `generateOnboardingTasks` returns `{ created: Task[]; skipped: number }` and the worker's `handleGenerateOnboarding` narrows it to `{ created: number; skipped: number }` — the worker test asserts the numeric shape, the core test asserts the row shape. `generateRecurringTasks` returns `{ created: number; skipped: number }` throughout. `updateTaskStatus` returns `{ task, onboardingCompleted, handoverRecorded }` and every caller destructures `task`. `TaskFilters.assigneeUserId` is a single string carrying the sentinel `"unassigned"`, matching the filter form's `<option value="unassigned">`. `FINISHED_STATUSES` is defined once in `update-task-status.ts` and imported by `assignee.ts` and `find-overdue-tasks.ts`.
- **Import direction.** `packages/db/src/seed.ts` never imports `@launchos/core`; its onboarding-task insert duplicates the generator's rules on purpose and Task 12 says so in a comment. `apps/web/src/lib/queue.ts` uses the queue name as a literal because `apps/web` must not depend on `@launchos/worker`; Task 9 flags that the literal and `QUEUE.tasksGenerateOnboarding` must stay in step.
- **Tenancy.** Every service filters on `organisationId`, and each of `createTask`, `updateTaskStatus`, `assignTask`, `commentOnTask`, `toggleChecklistItem`, `setTaskVisibility`, `updatePackage`, `updateTaskTemplate`, `deleteTaskTemplate`, `generateOnboardingTasks` has a cross-organisation rejection test.
- **File size.** The largest new files are `apps/web/src/app/(admin)/tasks/page.tsx` (~150 lines) and `apps/web/src/app/(admin)/tasks/[id]/page.tsx` (~170 lines); every core service is under 120 lines. All well inside the 800-line ceiling.
- **What Plan 4 gets.** `createTask` (Support Triage's `tasks_create` tool wraps it with `ticketId` and `phase: "support"`), `listTasks`, `updateTaskStatus`, `assignTask`, `pickLeastLoadedStaff` (`tickets_assign`), and the task enums exported from `@launchos/db/schema`. The client portal's `/portal/tasks` reads `listTasks(db, org, { clientId, clientVisible: true })` and the same `ProgressBar` component.
