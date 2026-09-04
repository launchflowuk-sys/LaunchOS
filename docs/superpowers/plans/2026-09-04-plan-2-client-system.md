# Plan 2: Client System + Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Plan 1 foundation into the client system Shoji actually runs the agency from: clients with contacts, address, billing profile and a generated support address; websites, domains and DNS records that belong to a client; a team he can add members to while abroad; a per-client timeline; in-app notifications; global search; and the final left-hand navigation with every screen those need.

**Architecture:** unchanged direction — `packages/db` (Drizzle + Postgres) → `packages/core` (domain services, `(db, organisationId, input)`) → `apps/web` (Next.js 16 admin route group) and `apps/worker` (pg-boss). Plan 2 adds no new agent and no new integration: it adds one migration, twelve core service folders, and the admin screens that drive them. `client.created`, `site.created`, `domain.created` and `member.created` are emitted now so Plan 3's task engine has something to subscribe to.

**Tech Stack:** Node 24, pnpm 11.12.0, TypeScript 5 strict, Next.js 16 (App Router, `--webpack`), React 19, Tailwind 4, shadcn/ui, Drizzle ORM + drizzle-kit, `postgres` driver, Better Auth 1.7, pg-boss 10, Zod 4, react-hook-form + `@hookform/resolvers`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-agency-os-full-build.md` (§1 row P2, §2, §3 P2, §4 client creation, §5, §7 P2)

## Global Constraints

- Node `>=24`, pnpm `11.12.0`, TypeScript `strict: true` with `noUncheckedIndexedAccess`.
- PostgreSQL 17 self-hosted only. No Supabase. No Redis.
- Every business table has `organisation_id uuid not null references organisations(id) on delete cascade`.
- Every core service signature is `(db: Db, organisationId: string, input)`.
- Any service taking a foreign id asserts ownership via `packages/core/src/tenancy/assert-owned.ts`.
- Multi-write services run inside `db.transaction`; domain events emit **after** commit.
- Tools declare `risk: "safe" | "requires_approval"`. Outward-facing tools are `requires_approval`.
- Default model `claude-opus-5`, `thinking: { type: "adaptive" }`, `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`.
- Never store card or bank numbers. `billing_profiles` is the whole financial surface: billing name, address, VAT number, payment terms, Stripe customer id, preferred method label.
- No secrets in code. Env validated with Zod at boot.
- UI: shadcn, white/light, dense but calm tables, grouped left sidebar, page header with primary action, empty states with a call to action, toasts on actions, Zod on both sides (react-hook-form + zod on the client, server action re-validates), sidebar collapses under 1024px, footer "Powered by LaunchFlow".
- Tests: Vitest on every core service against real Postgres (transaction rolled back via `withTestDb`); test data uses random slugs and emails; Playwright smoke for the plan's main flow.
- Files 800 lines max; functions under 50 lines.
- Commit after every task with a conventional-commit message.

---

## File structure for this plan

```
packages/db/src/schema/clients.ts            + slug, address, website_url, industry, support_email, package_id
packages/db/src/schema/sites.ts              + domains.client_id, dns_provider, nameservers, notes; site_id nullable
packages/db/src/schema/system.ts             + organisation_members profile columns; client_users FK
packages/db/src/schema/billing.ts            NEW billing_profiles
packages/db/src/schema/activity.ts           NEW activity_events, notifications
packages/db/drizzle/0003_client_system.sql   NEW migration (hand-edited backfills)
packages/core/src/config.ts                  supportEmailDomain(), supportEmailFor()
packages/core/src/tenancy/assert-owned.ts    + generic assertOwned(db, org, table, id)
packages/core/src/events/emit.ts             + client.created, site.created, domain.created, member.created
packages/core/src/activity/record-activity.ts, list-activity.ts
packages/core/src/notifications/notify.ts, list-notifications.ts
packages/core/src/clients/slug.ts, create-client.ts, update-client.ts, list-clients.ts
packages/core/src/clients/contacts.ts
packages/core/src/billing/upsert-billing-profile.ts
packages/core/src/sites/create-site.ts, update-site.ts, list-sites.ts
packages/core/src/domains/domains.ts, dns-records.ts
packages/core/src/team/password.ts, create-member.ts, list-members.ts, deactivate-member.ts
packages/core/src/search/search.ts
apps/web/src/lib/nav.ts, queue.ts
apps/web/src/components/app-nav.tsx, global-search.tsx, notifications-bell.tsx, form-fields.tsx
apps/web/src/app/api/search/route.ts
apps/web/src/app/(admin)/layout.tsx          rebuilt shell (sidebar groups, header, toaster)
apps/web/src/app/(admin)/notifications/actions.ts
apps/web/src/app/(admin)/clients/*           list, new-client dialog, detail tabs, actions
apps/web/src/app/(admin)/websites/*          list + detail (DNS, monitors, incidents)
apps/web/src/app/(admin)/domains/*           list + detail
apps/web/src/app/(admin)/team/*              list + add-member dialog + deactivate
apps/web/src/app/(admin)/settings/organisation/page.tsx
apps/web/tests/e2e/admin-shell.spec.ts, admin-clients.spec.ts, admin-team.spec.ts
packages/db/src/seed.ts                      slugs, support emails, contacts, billing, domains, staff member, activity
docs/MODULE_MAP.md, docs/DATA_MODEL.md, .env.example, README.md
```

---

### Task 1: Migration 0003 — client, billing, domain, member and timeline tables

**Files:**
- Modify: `packages/db/src/schema/clients.ts`, `packages/db/src/schema/sites.ts`, `packages/db/src/schema/system.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/seed.ts`, `packages/core/src/clients/create-client.ts`, `packages/core/src/index.ts`
- Create: `packages/db/src/schema/billing.ts`, `packages/db/src/schema/activity.ts`, `packages/db/drizzle/0003_client_system.sql`, `packages/core/src/clients/slug.ts`
- Test: `packages/db/src/schema/schema.test.ts` (extend)

**Interfaces:**
- Consumes: `tenantColumns()` (`packages/db/src/schema/_shared.ts`), `clients` / `sites` / `user` / `actorKindEnum` (existing schema files).
- Produces: `slugify(value: string) → string`, `uniqueClientSlug(db, organisationId, desired) → Promise<string>`; `createClient` keeps its existing signature and now also writes `slug`; tables `billing_profiles`, `activity_events`, `notifications`; enum `dns_provider`; columns `clients.slug` (not null, unique per organisation), `clients.address_line1/2`, `clients.city`, `clients.postcode`, `clients.country` (not null default `'GB'`), `clients.website_url`, `clients.industry`, `clients.support_email` (unique when set), `clients.package_id` (plain nullable uuid; FK in Plan 3); `domains.client_id` (not null), `domains.dns_provider`, `domains.nameservers text[]`, `domains.notes`, `domains.site_id` nullable; `organisation_members.display_name/title/phone/invited_by/initial_password_set_at`; FK `client_users.client_id → clients.id`.

- [ ] **Step 1: Extend the schema test (failing)**

Append to `packages/db/src/schema/schema.test.ts`:
```ts
describe("plan 2 schema", () => {
  it("stores a client with a slug and support email, its billing profile, a client-less domain and a timeline event", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "LaunchFlow", slug: `p2-${crypto.randomUUID()}` }).returning();
      const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;
      const [client] = await db.insert(clients).values({
        organisationId: org!.id, name: "Acme", slug, supportEmail: `${slug}@support.launchflow.test`,
        addressLine1: "1 High Street", city: "Grays", postcode: "RM17 6AA", websiteUrl: "https://acme.test", industry: "Retail",
      }).returning();
      expect(client!.country).toBe("GB");
      expect(client!.packageId).toBeNull();

      const [billing] = await db.insert(billingProfiles).values({ organisationId: org!.id, clientId: client!.id, billingName: "Acme Ltd" }).returning();
      expect(billing!.paymentTermsDays).toBe(14);

      const [domain] = await db.insert(domains).values({
        organisationId: org!.id, clientId: client!.id, name: `${slug}.test`, dnsProvider: "cloudflare", nameservers: ["ns1.test", "ns2.test"],
      }).returning();
      expect(domain!.siteId).toBeNull();
      expect(domain!.nameservers).toEqual(["ns1.test", "ns2.test"]);

      const [event] = await db.insert(activityEvents).values({
        organisationId: org!.id, clientId: client!.id, actorKind: "system", kind: "client.created", title: "Client created",
      }).returning();
      expect(event!.title).toBe("Client created");
      expect(event!.link).toBeNull();

      const [notification] = await db.insert(notifications).values({
        organisationId: org!.id, userId: await seedUserId(db), kind: "client.created", title: "New client",
      }).returning();
      expect(notification!.readAt).toBeNull();
    });
  });
});
```
Add `billingProfiles`, `activityEvents`, `notifications`, `domains`, `user` to the file's existing import from `./index.js`, and add the helper above the describe block:
```ts
async function seedUserId(db: Db): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name: "Member", email: `member-${id}@example.test`, emailVerified: true });
  return id;
}
```
(`Db` is already imported by the file's `withTestDb` helper import; add `type Db` to the `@launchos/db` import if it is not.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/db test`
Expected: FAIL — `billingProfiles`, `activityEvents` are not exported and `clients.slug` does not exist.

- [ ] **Step 3: Schema — clients**

Replace `packages/db/src/schema/clients.ts`:
```ts
import { boolean, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

export const clientStatusEnum = pgEnum("client_status", ["active", "paused", "archived"]);

export const clients = pgTable(
  "clients",
  {
    ...tenantColumns(),
    name: text("name").notNull(),
    // Used for the support address and portal URLs. Unique per organisation so
    // two organisations can both own a client called "acme".
    slug: text("slug").notNull(),
    tradingName: text("trading_name"),
    email: text("email"),
    phone: text("phone"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    postcode: text("postcode"),
    country: text("country").default("GB").notNull(),
    websiteUrl: text("website_url"),
    industry: text("industry"),
    // "<slug>@<SUPPORT_EMAIL_DOMAIN>". Globally unique: inbound mail is routed
    // by address alone, so two organisations must never share one.
    supportEmail: text("support_email"),
    // Plain uuid today; Plan 3 adds the FK to packages once that table exists.
    packageId: uuid("package_id"),
    status: clientStatusEnum("status").default("active").notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("clients_org_slug").on(t.organisationId, t.slug),
    uniqueIndex("clients_support_email").on(t.supportEmail),
  ],
);

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

- [ ] **Step 4: Schema — sites/domains, system, billing, activity**

In `packages/db/src/schema/sites.ts`, add the enum and replace the `domains` table (leave `sites` and `dnsRecords` untouched, and add `clients` to the existing import):
```ts
export const dnsProviderEnum = pgEnum("dns_provider", ["cloudflare", "registrar", "other"]);

export const domains = pgTable(
  "domains",
  {
    ...tenantColumns(),
    // A domain is bought for a client and may exist long before its site.
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    registrar: text("registrar"),
    dnsProvider: dnsProviderEnum("dns_provider").default("other").notNull(),
    nameservers: text("nameservers").array().$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    autoRenew: boolean("auto_renew").default(true).notNull(),
    status: domainStatusEnum("status").default("active").notNull(),
  },
  (t) => [uniqueIndex("domains_org_name").on(t.organisationId, t.name)],
);
```

In `packages/db/src/schema/system.ts`, import `clients` from `./clients.js` and replace the two tables' changed lines:
```ts
export const organisationMembers = pgTable("organisation_members", {
  ...tenantColumns(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  title: text("title"),
  phone: text("phone"),
  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
  initialPasswordSetAt: timestamp("initial_password_set_at", { withTimezone: true }),
  role: memberRoleEnum("role").default("staff").notNull(),
  status: memberStatusEnum("status").default("active").notNull(),
}, (t) => [uniqueIndex("organisation_members_org_user").on(t.organisationId, t.userId)]);

export const clientUsers = pgTable("client_users", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: clientUserRoleEnum("role").default("client_member").notNull(),
}, (t) => [uniqueIndex("client_users_client_user").on(t.clientId, t.userId)]);
```
Add `timestamp` to the `drizzle-orm/pg-core` import there.

`packages/db/src/schema/billing.ts`:
```ts
import { integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

// The entire "financial details" surface. No card numbers, no bank details:
// money movement is Stripe's job (Plan 5), and only its customer id lands here.
export const billingProfiles = pgTable(
  "billing_profiles",
  {
    ...tenantColumns(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    billingName: text("billing_name"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    postcode: text("postcode"),
    country: text("country").default("GB").notNull(),
    vatNumber: text("vat_number"),
    paymentTermsDays: integer("payment_terms_days").default(14).notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    preferredMethod: text("preferred_method"),
    notes: text("notes"),
  },
  (t) => [uniqueIndex("billing_profiles_client").on(t.clientId)],
);
```

`packages/db/src/schema/activity.ts`:
```ts
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { sites } from "./sites.js";
import { actorKindEnum } from "./support.js";

// The per-client timeline. Append-only narrative for humans; audit_log stays
// the machine record of who changed which field.
export const activityEvents = pgTable(
  "activity_events",
  {
    ...tenantColumns(),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorId: text("actor_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
  },
  (t) => [index("activity_events_client_time").on(t.clientId, t.createdAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    ...tenantColumns(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("notifications_user_unread").on(t.userId, t.readAt)],
);
```

`packages/db/src/schema/index.ts` — add after the `sites` line:
```ts
export * from "./billing.js";
export * from "./activity.js";
```

- [ ] **Step 5: Generate the migration and hand-edit the backfills**

Run: `pnpm --filter @launchos/db generate --name client_system`
Expected: `packages/db/drizzle/0003_client_system.sql`. drizzle-kit emits `ADD COLUMN "slug" text NOT NULL` and `ADD COLUMN "client_id" uuid NOT NULL`, which fail against seeded rows. Edit the file so those two columns arrive nullable, are backfilled, then take the constraint. The finished file must contain, in this order (keep every other generated statement drizzle-kit produced, and keep `--> statement-breakpoint` between statements):

```sql
CREATE TYPE "public"."dns_provider" AS ENUM('cloudflare', 'registrar', 'other');
CREATE TABLE "billing_profiles" (...);
CREATE TABLE "activity_events" (...);
CREATE TABLE "notifications" (...);
ALTER TABLE "clients" ADD COLUMN "slug" text;
ALTER TABLE "clients" ADD COLUMN "address_line1" text;
ALTER TABLE "clients" ADD COLUMN "address_line2" text;
ALTER TABLE "clients" ADD COLUMN "city" text;
ALTER TABLE "clients" ADD COLUMN "postcode" text;
ALTER TABLE "clients" ADD COLUMN "country" text DEFAULT 'GB' NOT NULL;
ALTER TABLE "clients" ADD COLUMN "website_url" text;
ALTER TABLE "clients" ADD COLUMN "industry" text;
ALTER TABLE "clients" ADD COLUMN "support_email" text;
ALTER TABLE "clients" ADD COLUMN "package_id" uuid;
UPDATE "clients" AS c SET "slug" = base.slug || CASE WHEN base.rn = 1 THEN '' ELSE '-' || base.rn::text END
  FROM (
    SELECT id,
           trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')) AS slug,
           row_number() OVER (
             PARTITION BY organisation_id, trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
             ORDER BY created_at, id
           ) AS rn
    FROM "clients"
  ) AS base
  WHERE c.id = base.id AND c."slug" IS NULL;
ALTER TABLE "clients" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "clients_org_slug" ON "clients" USING btree ("organisation_id","slug");
CREATE UNIQUE INDEX "clients_support_email" ON "clients" USING btree ("support_email");
ALTER TABLE "domains" ADD COLUMN "client_id" uuid;
ALTER TABLE "domains" ADD COLUMN "dns_provider" "dns_provider" DEFAULT 'other' NOT NULL;
ALTER TABLE "domains" ADD COLUMN "nameservers" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "domains" ADD COLUMN "notes" text;
UPDATE "domains" AS d SET "client_id" = s."client_id" FROM "sites" AS s WHERE s.id = d.site_id AND d."client_id" IS NULL;
ALTER TABLE "domains" ALTER COLUMN "client_id" SET NOT NULL;
ALTER TABLE "domains" ADD CONSTRAINT "domains_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "domains" ALTER COLUMN "site_id" DROP NOT NULL;
ALTER TABLE "domains" DROP CONSTRAINT "domains_site_id_sites_id_fk";
ALTER TABLE "domains" ADD CONSTRAINT "domains_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "organisation_members" ADD COLUMN "display_name" text;
ALTER TABLE "organisation_members" ADD COLUMN "title" text;
ALTER TABLE "organisation_members" ADD COLUMN "phone" text;
ALTER TABLE "organisation_members" ADD COLUMN "invited_by" text;
ALTER TABLE "organisation_members" ADD COLUMN "initial_password_set_at" timestamp with time zone;
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "client_users" ADD CONSTRAINT "client_users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
```
Do not touch `packages/db/drizzle/meta/*` by hand — drizzle-kit wrote the snapshot from the schema, which is already correct.

- [ ] **Step 6: Keep the seed insertable**

`packages/db/src/seed.ts` — `SEED_CLIENTS` entries gain a `slug`, and `seedClient` supplies `slug` plus `supportEmail`. Replace the constant and the function:
```ts
const SUPPORT_EMAIL_DOMAIN = process.env.SUPPORT_EMAIL_DOMAIN ?? "support.launchflow.co.uk";

const SEED_CLIENTS = [
  { name: "Grays CabLine", slug: "grays-cabline", email: "info@grayscabline.co.uk", url: "https://grayscabline.co.uk" },
  { name: "Mobile PC Doctor", slug: "mobile-pc-doctor", email: "info@mobilepcdoctor.co.uk", url: "https://mobilepcdoctor.co.uk" },
] as const;

async function seedClient(db: Db, organisationId: string, spec: (typeof SEED_CLIENTS)[number]) {
  const [existing] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, spec.name)));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.clients)
    .values({
      organisationId,
      name: spec.name,
      slug: spec.slug,
      email: spec.email,
      supportEmail: `${spec.slug}@${SUPPORT_EMAIL_DOMAIN}`,
    })
    .returning();
  return created!;
}
```

- [ ] **Step 7: Keep `createClient` insertable (slug helper)**

`clients.slug` is now NOT NULL, so the Plan 1 `createClient` — and every core test that uses it — stops working until it supplies one. Add the helper now; Task 4 builds the rest of the client service on top of it.

`packages/core/src/clients/slug.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, like } from "drizzle-orm";

/** "Grays CabLine" → "grays-cabline". Only [a-z0-9-] survives. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/**
 * The first free slug in the organisation: "acme", then "acme-2", "acme-3".
 * The slug is the support address's local part, so it has to be stable and
 * readable, not a random id.
 */
export async function uniqueClientSlug(db: Db, organisationId: string, desired: string): Promise<string> {
  const base = slugify(desired) || "client";
  // `base` is already [a-z0-9-] only, so it carries no LIKE metacharacters.
  const rows = await db
    .select({ slug: schema.clients.slug })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), like(schema.clients.slug, `${base}%`)));
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate a unique slug for "${desired}"`);
}
```

In `packages/core/src/clients/create-client.ts`, add the import and the two changed lines:
```ts
import { uniqueClientSlug } from "./slug.js";
// ...
export async function createClient(db: Db, organisationId: string, input: CreateClientInput) {
  const v = CreateClientInput.parse(input);
  const slug = await uniqueClientSlug(db, organisationId, v.name);
  const [client] = await db.insert(schema.clients).values({ organisationId, slug, ...v }).returning();
  await recordAudit(db, organisationId, { actorKind: "system", action: "client.created", targetType: "client", targetId: client!.id, after: client });
  return client!;
}
```
Append to `packages/core/src/index.ts`:
```ts
export { slugify, uniqueClientSlug } from "./clients/slug.js";
```

- [ ] **Step 8: Apply and run**

Run: `pnpm db:up && pnpm db:migrate && pnpm db:seed && pnpm --filter @launchos/db test && pnpm --filter @launchos/core test`
Expected: migration applies against the seeded database, seed prints the same ids as before, both suites PASS.

- [ ] **Step 9: Document the new tables**

`docs/DATA_MODEL.md` — under `## clients.ts` extend the `clients` bullet with `slug` (unique per organisation), `address_line1/2`, `city`, `postcode`, `country` (default `GB`), `website_url`, `industry`, `support_email` (globally unique, `<slug>@SUPPORT_EMAIL_DOMAIN`), `package_id` (FK added in Plan 3); under `## sites.ts` change the `domains` bullet to `client_id`, `site_id?`, `dns_provider` (`cloudflare|registrar|other`), `nameservers text[]`, `notes`; under `## system.ts` extend `organisation_members` with `display_name`, `title`, `phone`, `invited_by`, `initial_password_set_at` and note `client_users.client_id` now has its FK. Add two new sections:
```md
## billing.ts
- `billing_profiles`: `client_id` unique, `billing_name`, `address_line1/2`, `city`, `postcode`, `country` (default `GB`), `vat_number`, `payment_terms_days` (default 14), `stripe_customer_id?`, `preferred_method?`, `notes?`. No card or bank numbers, ever.

## activity.ts
- `activity_events`: `client_id?`, `site_id?`, `actor_kind`, `actor_id?`, `kind`, `title`, `body?`, `link?`. Index on `(client_id, created_at)`. The human-readable per-client timeline; `audit_log` remains the machine record.
- `notifications`: `user_id`, `kind`, `title`, `body?`, `link?`, `read_at?`. Index on `(user_id, read_at)`.
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0003 adds client slugs and addresses, billing profiles, client-owned domains, member profiles, activity events and notifications"
```

---

### Task 2: Generic ownership assertion and the extended domain event union

**Files:**
- Modify: `packages/core/src/tenancy/assert-owned.ts`, `packages/core/src/tenancy/assert-owned.test.ts`, `packages/core/src/events/emit.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Db`, `schema` from `@launchos/db`.
- Produces:
  - `assertOwned(db: Db, organisationId: string, table: OwnedTable, id: string): Promise<void>` — throws `` `${singular table name} ${id} not found in organisation` ``.
  - `type OwnedTable = PgTable & { id: Column; organisationId: Column }`.
  - `assertClientInOrganisation` / `assertSiteInOrganisation` keep their existing signatures and error strings.
  - `DomainEvent` gains `{ name: "client.created"; organisationId: string; clientId: string }`, `{ name: "site.created"; organisationId: string; siteId: string }`, `{ name: "domain.created"; organisationId: string; domainId: string }`, `{ name: "member.created"; organisationId: string; memberId: string }`.

- [ ] **Step 1: Failing test for the generic helper**

Append to `packages/core/src/tenancy/assert-owned.test.ts` (add `assertOwned` to the import from `./assert-owned.js`):
```ts
describe("assertOwned", () => {
  it("names the table in its error and works for any tenant table", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db, "A");
      const orgB = await makeOrg(db, "B");
      const client = await createClient(db, orgA.id, { name: "A client" });
      const [domain] = await db
        .insert(schema.domains)
        .values({ organisationId: orgA.id, clientId: client.id, name: `${crypto.randomUUID()}.test` })
        .returning();

      await expect(assertOwned(db, orgA.id, schema.domains, domain!.id)).resolves.toBeUndefined();
      await expect(assertOwned(db, orgB.id, schema.domains, domain!.id)).rejects.toThrow(
        `domain ${domain!.id} not found in organisation`,
      );
      await expect(assertOwned(db, orgB.id, schema.clients, client.id)).rejects.toThrow(
        `client ${client.id} not found in organisation`,
      );
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @launchos/core test -- assert-owned`
Expected: FAIL — `assertOwned` is not exported.

- [ ] **Step 3: Implement `assertOwned`**

Replace `packages/core/src/tenancy/assert-owned.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, getTableName, type Column } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * Ownership guards for ids that arrive from outside the trust boundary — an
 * agent's tool input, an API body, a form post. Every domain write that takes
 * a foreign key it did not itself look up asserts first, so a caller cannot
 * reach across organisations by guessing or replaying an id.
 */
export type OwnedTable = PgTable & { id: Column; organisationId: Column };

/** "billing_profiles" → "billing_profile", "clients" → "client". */
function subjectOf(table: OwnedTable): string {
  const name = getTableName(table);
  return name.endsWith("s") ? name.slice(0, -1) : name;
}

export async function assertOwned(db: Db, organisationId: string, table: OwnedTable, id: string): Promise<void> {
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.organisationId, organisationId)))
    .limit(1);
  if (!row) throw new Error(`${subjectOf(table)} ${id} not found in organisation`);
}

export async function assertClientInOrganisation(db: Db, organisationId: string, clientId: string): Promise<void> {
  await assertOwned(db, organisationId, schema.clients, clientId);
}

export async function assertSiteInOrganisation(db: Db, organisationId: string, siteId: string): Promise<void> {
  await assertOwned(db, organisationId, schema.sites, siteId);
}
```

- [ ] **Step 4: Extend the event union**

Replace the type in `packages/core/src/events/emit.ts` (leave `setEnqueue` / `emit` as they are):
```ts
export type DomainEvent =
  | { name: "incident.opened"; organisationId: string; incidentId: string }
  | { name: "ticket.created"; organisationId: string; ticketId: string }
  | { name: "client.created"; organisationId: string; clientId: string }
  | { name: "site.created"; organisationId: string; siteId: string }
  | { name: "domain.created"; organisationId: string; domainId: string }
  | { name: "member.created"; organisationId: string; memberId: string };
```

- [ ] **Step 5: Export and run the suite**

In `packages/core/src/index.ts` replace the tenancy export line with:
```ts
export { assertOwned, assertClientInOrganisation, assertSiteInOrganisation } from "./tenancy/assert-owned.js";
export type { OwnedTable } from "./tenancy/assert-owned.js";
```
Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS — the worker's `setEnqueue` callback still narrows on `event.name === "incident.opened"` and ignores the new members.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): generic assertOwned helper and client/site/domain/member domain events"
```

---

### Task 3: Activity timeline and notifications services

**Files:**
- Create: `packages/core/src/activity/record-activity.ts`, `packages/core/src/activity/list-activity.ts`, `packages/core/src/notifications/notify.ts`, `packages/core/src/notifications/list-notifications.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/activity/record-activity.test.ts`, `packages/core/src/notifications/notify.test.ts`

**Interfaces:**
- Consumes: `assertOwned`, `schema.activityEvents`, `schema.notifications`, `schema.organisationMembers`, `schema.user`.
- Produces:
  - `recordActivity(db, organisationId, { clientId?, siteId?, actorKind?, actorId?, kind, title, body?, link? }) → ActivityEvent`
  - `listActivity(db, organisationId, { clientId?, siteId?, limit? }) → ActivityEvent[]` (newest first, default limit 50)
  - `notify(db, organisationId, { userId, kind, title, body?, link? }) → Notification`
  - `notifyOwner(db, organisationId, { kind, title, body?, link? }) → Notification | null`
  - `listNotifications(db, organisationId, { userId, unreadOnly?, limit? }) → Notification[]`
  - `countUnreadNotifications(db, organisationId, userId) → number`
  - `markNotificationRead(db, organisationId, { userId, notificationId }) → Notification | null`
  - `markAllNotificationsRead(db, organisationId, userId) → number`

- [ ] **Step 1: Failing tests**

`packages/core/src/activity/record-activity.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { listActivity } from "./list-activity.js";
import { recordActivity } from "./record-activity.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

// Inserted directly rather than through createClient: this task lands before
// the client service learns about slugs.
async function makeClient(db: Db, organisationId: string) {
  const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;
  const [client] = await db.insert(schema.clients).values({ organisationId, name: "Acme", slug }).returning();
  return client!;
}

describe("recordActivity", () => {
  it("records newest-first events for a client and refuses another organisation's client", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const client = await makeClient(db, orgA.id);

      await recordActivity(db, orgA.id, { clientId: client.id, kind: "client.created", title: "Client created" });
      await recordActivity(db, orgA.id, {
        clientId: client.id, actorKind: "user", actorId: "u1", kind: "contact.added", title: "Contact added", link: `/clients/${client.id}`,
      });

      const events = await listActivity(db, orgA.id, { clientId: client.id });
      expect(events.map((e) => e.kind)).toEqual(["contact.added", "client.created"]);
      expect(events[0]!.actorKind).toBe("user");

      await expect(
        recordActivity(db, orgB.id, { clientId: client.id, kind: "x", title: "y" }),
      ).rejects.toThrow(`client ${client.id} not found in organisation`);
    });
  });
});
```

`packages/core/src/notifications/notify.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { countUnreadNotifications, listNotifications, markNotificationRead } from "./list-notifications.js";
import { notify, notifyOwner } from "./notify.js";

async function makeOrgWithOwner(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const id = crypto.randomUUID();
  const [owner] = await db
    .insert(schema.user)
    .values({ id, name: "Owner", email: `owner-${id}@example.test`, emailVerified: true })
    .returning();
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}

describe("notifications", () => {
  it("notifies the owner, counts unread and marks one read", async () => {
    await withTestDb(async (db) => {
      const { org, owner } = await makeOrgWithOwner(db);

      const first = await notifyOwner(db, org.id, { kind: "ticket.created", title: "New ticket", link: "/tickets" });
      expect(first?.userId).toBe(owner.id);
      await notify(db, org.id, { userId: owner.id, kind: "site.down", title: "Site down" });

      expect(await countUnreadNotifications(db, org.id, owner.id)).toBe(2);
      const unread = await listNotifications(db, org.id, { userId: owner.id, unreadOnly: true });
      expect(unread).toHaveLength(2);

      const read = await markNotificationRead(db, org.id, { userId: owner.id, notificationId: first!.id });
      expect(read?.readAt).toBeInstanceOf(Date);
      expect(await countUnreadNotifications(db, org.id, owner.id)).toBe(1);
    });
  });

  it("returns null when the organisation has no owner", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      expect(await notifyOwner(db, org!.id, { kind: "x", title: "y" })).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./record-activity.js`, `./list-activity.js`, `./notify.js`, `./list-notifications.js` not found.

- [ ] **Step 3: Implement activity**

`packages/core/src/activity/record-activity.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { assertOwned } from "../tenancy/assert-owned.js";

export const RecordActivityInput = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  link: z.string().max(500).optional(),
});
export type RecordActivityInput = z.input<typeof RecordActivityInput>;

/**
 * Appends one entry to the client timeline. Safe to call inside a transaction
 * (pass the tx as `db`) so the narrative commits with the change it describes.
 */
export async function recordActivity(db: Db, organisationId: string, input: RecordActivityInput) {
  const v = RecordActivityInput.parse(input);
  if (v.clientId) await assertOwned(db, organisationId, schema.clients, v.clientId);
  if (v.siteId) await assertOwned(db, organisationId, schema.sites, v.siteId);
  const [row] = await db
    .insert(schema.activityEvents)
    .values({
      organisationId,
      clientId: v.clientId ?? null,
      siteId: v.siteId ?? null,
      actorKind: v.actorKind,
      actorId: v.actorId ?? null,
      kind: v.kind,
      title: v.title,
      body: v.body ?? null,
      link: v.link ?? null,
    })
    .returning();
  return row!;
}
```

`packages/core/src/activity/list-activity.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

export const ListActivityInput = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListActivityInput = z.input<typeof ListActivityInput>;

export async function listActivity(db: Db, organisationId: string, input: ListActivityInput = {}) {
  const v = ListActivityInput.parse(input);
  return db
    .select()
    .from(schema.activityEvents)
    .where(
      and(
        eq(schema.activityEvents.organisationId, organisationId),
        v.clientId ? eq(schema.activityEvents.clientId, v.clientId) : undefined,
        v.siteId ? eq(schema.activityEvents.siteId, v.siteId) : undefined,
      ),
    )
    .orderBy(desc(schema.activityEvents.createdAt))
    .limit(v.limit);
}
```

- [ ] **Step 4: Implement notifications**

`packages/core/src/notifications/notify.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

export const NotifyInput = z.object({
  userId: z.string().min(1),
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  link: z.string().max(500).optional(),
});
export type NotifyInput = z.input<typeof NotifyInput>;

export async function notify(db: Db, organisationId: string, input: NotifyInput) {
  const v = NotifyInput.parse(input);
  const [row] = await db
    .insert(schema.notifications)
    .values({ organisationId, userId: v.userId, kind: v.kind, title: v.title, body: v.body ?? null, link: v.link ?? null })
    .returning();
  return row!;
}

export const NotifyOwnerInput = NotifyInput.omit({ userId: true });
export type NotifyOwnerInput = z.input<typeof NotifyOwnerInput>;

/**
 * In-app notification for whoever runs the organisation — the oldest active
 * owner membership. Returns null when there is no owner yet (a fresh
 * organisation before the seed), so callers never fail because of it.
 * Email delivery to OWNER_NOTIFY_EMAIL arrives with the email adapter in Plan 4.
 */
export async function notifyOwner(db: Db, organisationId: string, input: NotifyOwnerInput) {
  const v = NotifyOwnerInput.parse(input);
  const [owner] = await db
    .select({ userId: schema.organisationMembers.userId })
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.role, "owner"),
        eq(schema.organisationMembers.status, "active"),
      ),
    )
    .orderBy(asc(schema.organisationMembers.createdAt))
    .limit(1);
  if (!owner) return null;
  return notify(db, organisationId, { ...v, userId: owner.userId });
}
```

`packages/core/src/notifications/list-notifications.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

export const ListNotificationsInput = z.object({
  userId: z.string().min(1),
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
});
export type ListNotificationsInput = z.input<typeof ListNotificationsInput>;

export async function listNotifications(db: Db, organisationId: string, input: ListNotificationsInput) {
  const v = ListNotificationsInput.parse(input);
  return db
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organisationId, organisationId),
        eq(schema.notifications.userId, v.userId),
        v.unreadOnly ? isNull(schema.notifications.readAt) : undefined,
      ),
    )
    .orderBy(desc(schema.notifications.createdAt))
    .limit(v.limit);
}

export async function countUnreadNotifications(db: Db, organisationId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organisationId, organisationId),
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
      ),
    );
  return row?.value ?? 0;
}

export const MarkReadInput = z.object({ userId: z.string().min(1), notificationId: z.string().uuid() });
export type MarkReadInput = z.input<typeof MarkReadInput>;

/** Scoped by userId as well as organisation: nobody reads another user's bell. */
export async function markNotificationRead(db: Db, organisationId: string, input: MarkReadInput) {
  const v = MarkReadInput.parse(input);
  const [row] = await db
    .update(schema.notifications)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.notifications.id, v.notificationId),
        eq(schema.notifications.organisationId, organisationId),
        eq(schema.notifications.userId, v.userId),
        isNull(schema.notifications.readAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function markAllNotificationsRead(db: Db, organisationId: string, userId: string): Promise<number> {
  const rows = await db
    .update(schema.notifications)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.notifications.organisationId, organisationId),
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
      ),
    )
    .returning({ id: schema.notifications.id });
  return rows.length;
}
```

- [ ] **Step 5: Export and run**

Append to `packages/core/src/index.ts`:
```ts
export { recordActivity, RecordActivityInput } from "./activity/record-activity.js";
export { listActivity, ListActivityInput } from "./activity/list-activity.js";
export { notify, notifyOwner, NotifyInput, NotifyOwnerInput } from "./notifications/notify.js";
export {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  ListNotificationsInput,
  MarkReadInput,
} from "./notifications/list-notifications.js";
```
Run: `pnpm --filter @launchos/core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): per-client activity timeline and in-app notifications with notifyOwner"
```

---

### Task 4: Client services — create with slug and support email, update, archive, list

**Files:**
- Create: `packages/core/src/config.ts`, `packages/core/src/clients/update-client.ts`, `packages/core/src/clients/list-clients.ts`
- Modify: `packages/core/src/clients/create-client.ts`, `packages/core/src/index.ts`, `apps/worker/src/boss.ts`, `apps/worker/src/index.ts`, `apps/web/package.json`, `.env.example`
- Create: `apps/web/src/lib/queue.ts`
- Test: `packages/core/src/clients/create-client.test.ts`, `packages/core/src/clients/list-clients.test.ts`

**Interfaces:**
- Consumes: `recordAudit` (`packages/core/src/audit/record-audit.ts`), `recordActivity` (Task 3), `emit` + `DomainEvent` (Task 2), `uniqueClientSlug` (Task 1), `assertOwned` (Task 2).
- Produces:
  - `supportEmailDomain(env?) → string`, `supportEmailFor(slug, env?) → string`, `DEFAULT_SUPPORT_EMAIL_DOMAIN`
  - `createClient(db, organisationId, { name, slug?, tradingName?, email?, phone?, addressLine1?, addressLine2?, city?, postcode?, country?, websiteUrl?, industry?, notes?, actorKind?, actorId? }) → Client` — the returned row includes `slug` and `supportEmail`; also writes an empty `billing_profiles` row and a `client.created` activity event, then emits `{ name: "client.created", organisationId, clientId }`
  - `updateClient(db, organisationId, { clientId, ...patch, actorKind?, actorId? }) → Client`
  - `archiveClient(db, organisationId, { clientId, actorKind?, actorId? }) → Client`
  - `listClients(db, organisationId, { query?, status?, limit?, offset? }) → ClientListRow[]` where `ClientListRow = { id, name, slug, status, email, phone, supportEmail, siteCount, domainCount, createdAt }`
  - `getClient(db, organisationId, clientId) → Client | null`
  - `escapeLike(value: string) → string`
  - `apps/web/src/lib/queue.ts` → `installWebEnqueue(): void`
  - `apps/worker` → `QUEUE.domainEvent = "domain.event"`

- [ ] **Step 1: Failing tests**

`packages/core/src/clients/create-client.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { archiveClient, updateClient } from "./update-client.js";
import { createClient } from "./create-client.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("createClient", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => {
    events.length = 0;
    process.env.SUPPORT_EMAIL_DOMAIN = "support.launchflow.test";
    setEnqueue(async (event) => { events.push(event); });
  });

  it("derives a unique slug and support email, opens a billing profile, logs the timeline and emits client.created", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const first = await createClient(db, org.id, {
        name: "Grays CabLine", email: "info@grayscabline.co.uk", phone: "01375 000000",
        addressLine1: "1 High Street", city: "Grays", postcode: "RM17 6AA", actorKind: "user", actorId: "u1",
      });
      expect(first.slug).toBe("grays-cabline");
      expect(first.supportEmail).toBe("grays-cabline@support.launchflow.test");
      expect(first.country).toBe("GB");

      const second = await createClient(db, org.id, { name: "Grays CabLine" });
      expect(second.slug).toBe("grays-cabline-2");
      expect(second.supportEmail).toBe("grays-cabline-2@support.launchflow.test");

      const [billing] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, first.id));
      expect(billing?.paymentTermsDays).toBe(14);

      const timeline = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.clientId, first.id));
      expect(timeline.map((e) => e.kind)).toEqual(["client.created"]);
      expect(timeline[0]!.actorId).toBe("u1");

      expect(events).toEqual([
        { name: "client.created", organisationId: org.id, clientId: first.id },
        { name: "client.created", organisationId: org.id, clientId: second.id },
      ]);
    });
  });

  it("updates fields and archives without touching the slug", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });

      const updated = await updateClient(db, org.id, {
        clientId: client.id, city: "Grays", industry: "Retail", actorKind: "user", actorId: "u1",
      });
      expect(updated.city).toBe("Grays");
      expect(updated.slug).toBe(client.slug);
      expect(updated.supportEmail).toBe(client.supportEmail);

      const archived = await archiveClient(db, org.id, { clientId: client.id, actorKind: "user", actorId: "u1" });
      expect(archived.status).toBe("archived");
    });
  });
});
```

`packages/core/src/clients/list-clients.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "./create-client.js";
import { getClient, listClients } from "./list-clients.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("listClients", () => {
  it("filters by status, matches name/slug/email case-insensitively and counts sites and domains", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const cab = await createClient(db, org.id, { name: "Grays CabLine", email: "info@grayscabline.co.uk" });
      const doc = await createClient(db, org.id, { name: "Mobile PC Doctor" });
      await db.insert(schema.clients).values({ organisationId: org.id, name: "Old Co", slug: "old-co", status: "archived" });

      const [site] = await db
        .insert(schema.sites)
        .values({ organisationId: org.id, clientId: cab.id, name: "cabline", primaryUrl: "https://cabline.test" })
        .returning();
      await db.insert(schema.domains).values([
        { organisationId: org.id, clientId: cab.id, siteId: site!.id, name: `a-${crypto.randomUUID()}.test` },
        { organisationId: org.id, clientId: cab.id, name: `b-${crypto.randomUUID()}.test` },
      ]);

      const active = await listClients(db, org.id, { status: "active" });
      expect(active.map((c) => c.id).sort()).toEqual([cab.id, doc.id].sort());

      const [match] = await listClients(db, org.id, { query: "GRAYSCABLINE.CO.UK" });
      expect(match!.id).toBe(cab.id);
      expect(match!.siteCount).toBe(1);
      expect(match!.domainCount).toBe(2);

      expect(await listClients(db, org.id, { query: "mobile-pc" })).toHaveLength(1);
      expect(await listClients(db, org.id, { status: "archived" })).toHaveLength(1);
      expect((await getClient(db, org.id, doc.id))?.name).toBe("Mobile PC Doctor");
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./update-client.js` and `./list-clients.js` not found, and `createClient` returns no `supportEmail`.

- [ ] **Step 3: Support email configuration**

`packages/core/src/config.ts`:
```ts
import { z } from "zod";

/** Falls back to LaunchFlow's own domain so local dev and tests work unset. */
export const DEFAULT_SUPPORT_EMAIL_DOMAIN = "support.launchflow.co.uk";

const Domain = z
  .string()
  .min(4)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);

export function supportEmailDomain(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SUPPORT_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!raw) return DEFAULT_SUPPORT_EMAIL_DOMAIN;
  return Domain.parse(raw);
}

export function supportEmailFor(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${slug}@${supportEmailDomain(env)}`;
}
```

- [ ] **Step 4: Implement createClient**

Replace `packages/core/src/clients/create-client.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { supportEmailFor } from "../config.js";
import { emit } from "../events/emit.js";
import { uniqueClientSlug } from "./slug.js";

export const CreateClientInput = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().max(48).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
  tradingName: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  postcode: z.string().max(20).optional(),
  country: z.string().length(2).default("GB"),
  websiteUrl: z.string().url().optional(),
  industry: z.string().max(100).optional(),
  notes: z.string().max(4000).optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateClientInput = z.input<typeof CreateClientInput>;

/**
 * Creates the client, its (empty) billing profile and the first timeline entry
 * in one transaction, then emits `client.created` so Plan 3's task engine can
 * generate the onboarding list. `support_email` is stored as a string here;
 * Plan 4 adds the routable `email_identities` row for the same address.
 */
export async function createClient(db: Db, organisationId: string, input: CreateClientInput) {
  const { actorKind, actorId, slug: desiredSlug, ...fields } = CreateClientInput.parse(input);
  const slug = await uniqueClientSlug(db, organisationId, desiredSlug ?? fields.name);
  const supportEmail = supportEmailFor(slug);

  const client = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [row] = await tx.insert(schema.clients).values({ organisationId, ...fields, slug, supportEmail }).returning();
    await tx.insert(schema.billingProfiles).values({
      organisationId,
      clientId: row!.id,
      billingName: fields.tradingName ?? fields.name,
      addressLine1: fields.addressLine1 ?? null,
      addressLine2: fields.addressLine2 ?? null,
      city: fields.city ?? null,
      postcode: fields.postcode ?? null,
      country: fields.country,
    });
    await recordActivity(inner, organisationId, {
      clientId: row!.id,
      actorKind,
      actorId,
      kind: "client.created",
      title: `Client created: ${row!.name}`,
      body: `Support address ${supportEmail}`,
      link: `/clients/${row!.id}`,
    });
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "client.created", targetType: "client", targetId: row!.id, after: row,
    });
    return row!;
  });

  // After commit: a subscriber must never see an id the transaction rolled back.
  await emit({ name: "client.created", organisationId, clientId: client.id });
  return client;
}
```

- [ ] **Step 5: Implement update and archive**

`packages/core/src/clients/update-client.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";

const ACTOR = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

export const UpdateClientInput = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  tradingName: z.string().max(200).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(40).nullish(),
  addressLine1: z.string().max(200).nullish(),
  addressLine2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(),
  postcode: z.string().max(20).nullish(),
  country: z.string().length(2).optional(),
  websiteUrl: z.string().url().nullish(),
  industry: z.string().max(100).nullish(),
  notes: z.string().max(4000).nullish(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  ...ACTOR,
});
export type UpdateClientInput = z.input<typeof UpdateClientInput>;

/** `slug` and `supportEmail` are deliberately not patchable: mail already routes to them. */
export async function updateClient(db: Db, organisationId: string, input: UpdateClientInput) {
  const { clientId, actorKind, actorId, ...patch } = UpdateClientInput.parse(input);
  const where = and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.clients).where(where);
    if (!before) throw new Error(`client ${clientId} not found in organisation`);
    const [after] = await tx.update(schema.clients).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "client.updated", targetType: "client", targetId: clientId, before, after,
    });
    return after!;
  });
}

export const ArchiveClientInput = z.object({ clientId: z.string().uuid(), ...ACTOR });
export type ArchiveClientInput = z.input<typeof ArchiveClientInput>;

export async function archiveClient(db: Db, organisationId: string, input: ArchiveClientInput) {
  const v = ArchiveClientInput.parse(input);
  const client = await updateClient(db, organisationId, {
    clientId: v.clientId, status: "archived", actorKind: v.actorKind, actorId: v.actorId,
  });
  await recordActivity(db, organisationId, {
    clientId: client.id, actorKind: v.actorKind, actorId: v.actorId,
    kind: "client.archived", title: `Client archived: ${client.name}`, link: `/clients/${client.id}`,
  });
  return client;
}
```

- [ ] **Step 6: Implement list and get**

`packages/core/src/clients/list-clients.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";

export const ListClientsInput = z.object({
  query: z.string().trim().max(100).optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).default(0),
});
export type ListClientsInput = z.input<typeof ListClientsInput>;

/** Postgres LIKE treats % _ \ as metacharacters; user text must not. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export type ClientListRow = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "paused" | "archived";
  email: string | null;
  phone: string | null;
  supportEmail: string | null;
  createdAt: Date;
  siteCount: number;
  domainCount: number;
};

export async function listClients(
  db: Db,
  organisationId: string,
  input: ListClientsInput = {},
): Promise<ClientListRow[]> {
  const v = ListClientsInput.parse(input);
  const term = v.query ? `%${escapeLike(v.query)}%` : undefined;

  return db
    .select({
      id: schema.clients.id,
      name: schema.clients.name,
      slug: schema.clients.slug,
      status: schema.clients.status,
      email: schema.clients.email,
      phone: schema.clients.phone,
      supportEmail: schema.clients.supportEmail,
      createdAt: schema.clients.createdAt,
      siteCount: sql<number>`(select count(*)::int from ${schema.sites} where ${schema.sites.clientId} = ${schema.clients.id})`,
      domainCount: sql<number>`(select count(*)::int from ${schema.domains} where ${schema.domains.clientId} = ${schema.clients.id})`,
    })
    .from(schema.clients)
    .where(
      and(
        eq(schema.clients.organisationId, organisationId),
        v.status ? eq(schema.clients.status, v.status) : undefined,
        term
          ? or(
              ilike(schema.clients.name, term),
              ilike(schema.clients.slug, term),
              ilike(schema.clients.email, term),
              ilike(schema.clients.supportEmail, term),
            )
          : undefined,
      ),
    )
    .orderBy(asc(schema.clients.name))
    .limit(v.limit)
    .offset(v.offset);
}

export async function getClient(db: Db, organisationId: string, clientId: string) {
  const [row] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  return row ?? null;
}
```

- [ ] **Step 7: Export and run the tests**

Append to `packages/core/src/index.ts`:
```ts
export { supportEmailDomain, supportEmailFor, DEFAULT_SUPPORT_EMAIL_DOMAIN } from "./config.js";
export { updateClient, archiveClient, UpdateClientInput, ArchiveClientInput } from "./clients/update-client.js";
export { listClients, getClient, escapeLike, ListClientsInput } from "./clients/list-clients.js";
export type { ClientListRow } from "./clients/list-clients.js";
```
Run: `pnpm --filter @launchos/core test`
Expected: PASS.

- [ ] **Step 8: Stop dropping web-originated events**

`client.created` is emitted from a server action, and the web process has no enqueue function, so today it would vanish. Give the worker a queue for raw domain events and the web a client that sends to it.

`apps/worker/src/boss.ts` — replace the QUEUE constant:
```ts
export const QUEUE = { monitorCheck: "monitor.check", agentRun: "agent.run", domainEvent: "domain.event" } as const;
```

`apps/worker/src/index.ts` — add `type DomainEvent` to the existing `@launchos/core` import, then replace the `setEnqueue(...)` block with:
```ts
  // One mapping for both entry points: events emitted inside the worker, and
  // events the web process sent through the domain.event queue.
  async function dispatchEvent(event: DomainEvent) {
    if (event.name === "incident.opened") {
      const payload = await incidentPayload(db, event.organisationId, event.incidentId);
      const job: AgentRunJob = { agentKey: "hosting-guard-dog", organisationId: event.organisationId, trigger: "event", payload };
      await boss.send(QUEUE.agentRun, job, { singletonKey: `guard-dog:${event.incidentId}` });
      return;
    }
    // client.created / site.created / domain.created / member.created have no
    // consumer until Plan 3's task engine; logged and ignored on purpose.
    console.info({ event: event.name }, "domain event with no consumer");
  }

  setEnqueue(dispatchEvent);

  await boss.work<DomainEvent>(QUEUE.domainEvent, async ([job]) => {
    await dispatchEvent(job!.data);
  });
```

`apps/web/src/lib/queue.ts`:
```ts
import { setEnqueue, type DomainEvent } from "@launchos/core";
import PgBoss from "pg-boss";

const QUEUE_DOMAIN_EVENT = "domain.event";

let bossPromise: Promise<PgBoss> | undefined;
let installed = false;

function getBoss(url: string): Promise<PgBoss> {
  // Cached as a promise so two concurrent requests share one pg-boss instance.
  bossPromise ??= (async () => {
    const boss = new PgBoss({ connectionString: url, schema: "pgboss" });
    boss.on("error", (e) => console.error("pg-boss error (web)", e));
    await boss.start();
    await boss.createQueue(QUEUE_DOMAIN_EVENT);
    return boss;
  })();
  return bossPromise;
}

/**
 * Routes domain events emitted inside the web process onto the queue the worker
 * consumes. Call it at the top of any server action that writes through a core
 * service; it is a no-op after the first call.
 */
export function installWebEnqueue(): void {
  if (installed) return;
  installed = true;
  setEnqueue(async (event: DomainEvent) => {
    const url = process.env.DATABASE_URL;
    if (!url) return;
    const boss = await getBoss(url);
    await boss.send(QUEUE_DOMAIN_EVENT, event);
  });
}
```
Add `"pg-boss": "^10"` to `apps/web/package.json` dependencies, then run `pnpm install`.

- [ ] **Step 9: Document the env vars**

`.env.example` — add after the `# ---- App ----` block:
```bash
# ---- Client support addresses ----
# Every client gets <slug>@SUPPORT_EMAIL_DOMAIN. Plan 4 routes real mail to it.
SUPPORT_EMAIL_DOMAIN=support.launchflow.co.uk
# In-app notifications always reach the owner; set this to also email them (Plan 4).
OWNER_NOTIFY_EMAIL=
```

- [ ] **Step 10: Typecheck and commit**

Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS.
```bash
git add -A
git commit -m "feat(core): client create/update/archive/list with slugs, support addresses, billing profile and client.created event"
```

---

### Task 5: Contact and billing profile services

**Files:**
- Create: `packages/core/src/clients/contacts.ts`, `packages/core/src/billing/upsert-billing-profile.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/clients/contacts.test.ts`, `packages/core/src/billing/upsert-billing-profile.test.ts`

**Interfaces:**
- Consumes: `assertOwned` (Task 2), `recordAudit`, `recordActivity` (Task 3), `createClient` (Task 4).
- Produces:
  - `createContact(db, organisationId, { clientId, name, email?, phone?, role?, isPrimary?, actorKind?, actorId? }) → ClientContact`
  - `updateContact(db, organisationId, { contactId, name?, email?, phone?, role?, isPrimary?, actorKind?, actorId? }) → ClientContact`
  - `deleteContact(db, organisationId, { contactId, actorKind?, actorId? }) → void`
  - `listContacts(db, organisationId, clientId) → ClientContact[]` (primary first, then name)
  - `upsertBillingProfile(db, organisationId, { clientId, billingName?, addressLine1?, addressLine2?, city?, postcode?, country?, vatNumber?, paymentTermsDays?, stripeCustomerId?, preferredMethod?, notes?, actorKind?, actorId? }) → BillingProfile`
  - `getBillingProfile(db, organisationId, clientId) → BillingProfile | null`

- [ ] **Step 1: Failing tests**

`packages/core/src/clients/contacts.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "./create-client.js";
import { createContact, deleteContact, listContacts, updateContact } from "./contacts.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("client contacts", () => {
  it("keeps exactly one primary contact and lists it first", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });

      const first = await createContact(db, org.id, {
        clientId: client.id, name: "Zoe", email: `zoe-${crypto.randomUUID()}@acme.test`, isPrimary: true,
      });
      const second = await createContact(db, org.id, {
        clientId: client.id, name: "Adam", phone: "07000 000000", isPrimary: true,
      });

      const contacts = await listContacts(db, org.id, client.id);
      expect(contacts.map((c) => c.name)).toEqual(["Adam", "Zoe"]);
      expect(contacts.filter((c) => c.isPrimary).map((c) => c.id)).toEqual([second.id]);

      await updateContact(db, org.id, { contactId: first.id, role: "Owner", isPrimary: true });
      const after = await listContacts(db, org.id, client.id);
      expect(after.filter((c) => c.isPrimary).map((c) => c.id)).toEqual([first.id]);

      await deleteContact(db, org.id, { contactId: second.id });
      expect(await listContacts(db, org.id, client.id)).toHaveLength(1);
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const client = await createClient(db, orgA.id, { name: "Acme" });
      await expect(createContact(db, orgB.id, { clientId: client.id, name: "Mallory" })).rejects.toThrow(
        `client ${client.id} not found in organisation`,
      );
    });
  });
});
```

`packages/core/src/billing/upsert-billing-profile.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { getBillingProfile, upsertBillingProfile } from "./upsert-billing-profile.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("upsertBillingProfile", () => {
  it("patches the profile createClient opened and never creates a second one", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });

      const saved = await upsertBillingProfile(db, org.id, {
        clientId: client.id, billingName: "Acme Ltd", vatNumber: "GB123456789", paymentTermsDays: 30, preferredMethod: "Bank transfer",
      });
      expect(saved.paymentTermsDays).toBe(30);

      const again = await upsertBillingProfile(db, org.id, { clientId: client.id, city: "Grays" });
      expect(again.id).toBe(saved.id);
      expect(again.vatNumber).toBe("GB123456789");
      expect((await getBillingProfile(db, org.id, client.id))?.city).toBe("Grays");
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./contacts.js` and `./upsert-billing-profile.js` not found.

- [ ] **Step 3: Implement contacts**

`packages/core/src/clients/contacts.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const ACTOR = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

export const CreateContactInput = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  role: z.string().max(100).optional(),
  isPrimary: z.boolean().default(false),
  ...ACTOR,
});
export type CreateContactInput = z.input<typeof CreateContactInput>;

/** Demotes every other primary contact for the client, inside the caller's transaction. */
async function demoteOthers(tx: Db, organisationId: string, clientId: string, keepId: string | null) {
  await tx
    .update(schema.clientContacts)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(schema.clientContacts.organisationId, organisationId),
        eq(schema.clientContacts.clientId, clientId),
        eq(schema.clientContacts.isPrimary, true),
        keepId ? ne(schema.clientContacts.id, keepId) : undefined,
      ),
    );
}

export async function createContact(db: Db, organisationId: string, input: CreateContactInput) {
  const { clientId, actorKind, actorId, ...fields } = CreateContactInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, clientId);

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    if (fields.isPrimary) await demoteOthers(inner, organisationId, clientId, null);
    const [row] = await tx.insert(schema.clientContacts).values({ organisationId, clientId, ...fields }).returning();
    await recordActivity(inner, organisationId, {
      clientId, actorKind, actorId, kind: "contact.added",
      title: `Contact added: ${row!.name}`, link: `/clients/${clientId}?tab=contacts`,
    });
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "contact.created", targetType: "client_contact", targetId: row!.id, after: row,
    });
    return row!;
  });
}

export const UpdateContactInput = z.object({
  contactId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().nullish(),
  phone: z.string().max(40).nullish(),
  role: z.string().max(100).nullish(),
  isPrimary: z.boolean().optional(),
  ...ACTOR,
});
export type UpdateContactInput = z.input<typeof UpdateContactInput>;

export async function updateContact(db: Db, organisationId: string, input: UpdateContactInput) {
  const { contactId, actorKind, actorId, ...patch } = UpdateContactInput.parse(input);
  const where = and(eq(schema.clientContacts.id, contactId), eq(schema.clientContacts.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.clientContacts).where(where);
    if (!before) throw new Error(`client_contact ${contactId} not found in organisation`);
    if (patch.isPrimary) await demoteOthers(inner, organisationId, before.clientId, contactId);
    const [after] = await tx.update(schema.clientContacts).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "contact.updated", targetType: "client_contact", targetId: contactId, before, after,
    });
    return after!;
  });
}

export const DeleteContactInput = z.object({ contactId: z.string().uuid(), ...ACTOR });
export type DeleteContactInput = z.input<typeof DeleteContactInput>;

export async function deleteContact(db: Db, organisationId: string, input: DeleteContactInput): Promise<void> {
  const { contactId, actorKind, actorId } = DeleteContactInput.parse(input);
  const where = and(eq(schema.clientContacts.id, contactId), eq(schema.clientContacts.organisationId, organisationId));
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.clientContacts).where(where);
    if (!before) throw new Error(`client_contact ${contactId} not found in organisation`);
    await tx.delete(schema.clientContacts).where(where);
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "contact.deleted", targetType: "client_contact", targetId: contactId, before,
    });
  });
}

export async function listContacts(db: Db, organisationId: string, clientId: string) {
  return db
    .select()
    .from(schema.clientContacts)
    .where(and(eq(schema.clientContacts.organisationId, organisationId), eq(schema.clientContacts.clientId, clientId)))
    .orderBy(desc(schema.clientContacts.isPrimary), asc(schema.clientContacts.name));
}
```

- [ ] **Step 4: Implement the billing profile**

`packages/core/src/billing/upsert-billing-profile.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const UpsertBillingProfileInput = z.object({
  clientId: z.string().uuid(),
  billingName: z.string().max(200).nullish(),
  addressLine1: z.string().max(200).nullish(),
  addressLine2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(),
  postcode: z.string().max(20).nullish(),
  country: z.string().length(2).optional(),
  vatNumber: z.string().max(40).nullish(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  stripeCustomerId: z.string().max(100).nullish(),
  preferredMethod: z.string().max(100).nullish(),
  notes: z.string().max(4000).nullish(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type UpsertBillingProfileInput = z.input<typeof UpsertBillingProfileInput>;

/**
 * Patch semantics: only the keys present are written, so a form that edits the
 * address never clears the VAT number. Card and bank numbers are not accepted
 * by this schema and must never be added to it.
 */
export async function upsertBillingProfile(db: Db, organisationId: string, input: UpsertBillingProfileInput) {
  const { clientId, actorKind, actorId, ...patch } = UpsertBillingProfileInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, clientId);
  const where = and(
    eq(schema.billingProfiles.organisationId, organisationId),
    eq(schema.billingProfiles.clientId, clientId),
  );

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.billingProfiles).where(where);
    const [after] = before
      ? await tx.update(schema.billingProfiles).set({ ...patch, updatedAt: new Date() }).where(where).returning()
      : await tx.insert(schema.billingProfiles).values({ organisationId, clientId, ...patch }).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "billing_profile.saved", targetType: "billing_profile", targetId: after!.id, before, after,
    });
    return after!;
  });
}

export async function getBillingProfile(db: Db, organisationId: string, clientId: string) {
  const [row] = await db
    .select()
    .from(schema.billingProfiles)
    .where(and(eq(schema.billingProfiles.organisationId, organisationId), eq(schema.billingProfiles.clientId, clientId)));
  return row ?? null;
}
```

- [ ] **Step 5: Export and run**

Append to `packages/core/src/index.ts`:
```ts
export {
  createContact, updateContact, deleteContact, listContacts,
  CreateContactInput, UpdateContactInput, DeleteContactInput,
} from "./clients/contacts.js";
export { upsertBillingProfile, getBillingProfile, UpsertBillingProfileInput } from "./billing/upsert-billing-profile.js";
```
Run: `pnpm --filter @launchos/core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): client contacts CRUD with a single-primary rule and billing profile upsert"
```

---

### Task 6: Site, domain and DNS record services

**Files:**
- Create: `packages/core/src/sites/update-site.ts`, `packages/core/src/sites/list-sites.ts`, `packages/core/src/domains/domains.ts`, `packages/core/src/domains/dns-records.ts`
- Modify: `packages/core/src/sites/create-site.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/sites/sites.test.ts`, `packages/core/src/domains/domains.test.ts`

**Interfaces:**
- Consumes: `assertOwned` (Task 2), `recordAudit`, `recordActivity` (Task 3), `emit` (Task 2), `createClient` (Task 4).
- Produces:
  - `createSite(db, organisationId, { clientId, name, primaryUrl, platform?, hostingProvider?, hostingRef?, actorKind?, actorId? }) → Site` (emits `site.created`)
  - `updateSite(db, organisationId, { siteId, name?, primaryUrl?, platform?, hostingProvider?, hostingRef?, status?, actorKind?, actorId? }) → Site`
  - `listSites(db, organisationId, { clientId?, query?, status? }) → SiteListRow[]` where `SiteListRow = { id, name, primaryUrl, platform, status, clientId, clientName, domainCount, openIncidentCount }`
  - `getSite(db, organisationId, siteId) → Site | null`
  - `createDomain(db, organisationId, { clientId, name, siteId?, registrar?, dnsProvider?, nameservers?, expiresAt?, autoRenew?, notes?, actorKind?, actorId? }) → Domain` (emits `domain.created`)
  - `updateDomain(db, organisationId, { domainId, siteId?, registrar?, dnsProvider?, nameservers?, expiresAt?, autoRenew?, status?, notes?, actorKind?, actorId? }) → Domain`
  - `deleteDomain(db, organisationId, { domainId, actorKind?, actorId? }) → void`
  - `listDomains(db, organisationId, { clientId?, siteId?, query? }) → DomainListRow[]` where `DomainListRow = { id, name, status, dnsProvider, registrar, expiresAt, clientId, clientName, siteId, siteName }`
  - `getDomain(db, organisationId, domainId) → Domain | null`
  - `createDnsRecord`, `updateDnsRecord`, `deleteDnsRecord`, `listDnsRecords(db, organisationId, domainId) → DnsRecord[]`

- [ ] **Step 1: Failing tests**

`packages/core/src/sites/sites.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createSite } from "./create-site.js";
import { getSite, listSites } from "./list-sites.js";
import { updateSite } from "./update-site.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("sites", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => { events.length = 0; setEnqueue(async (e) => { events.push(e); }); });

  it("creates, emits site.created, updates and lists with the client name and domain count", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });

      const site = await createSite(db, org.id, {
        clientId: client.id, name: "acme.test", primaryUrl: "https://acme.test", platform: "nextjs", actorKind: "user", actorId: "u1",
      });
      expect(site.platform).toBe("nextjs");
      expect(events).toEqual([{ name: "site.created", organisationId: org.id, siteId: site.id }]);

      await db.insert(schema.domains).values({ organisationId: org.id, clientId: client.id, siteId: site.id, name: `d-${crypto.randomUUID()}.test` });

      const paused = await updateSite(db, org.id, { siteId: site.id, status: "paused", hostingRef: "coolify-uuid" });
      expect(paused.status).toBe("paused");

      const [row] = await listSites(db, org.id, { clientId: client.id });
      expect(row!.clientName).toBe("Acme");
      expect(row!.domainCount).toBe(1);
      expect(row!.openIncidentCount).toBe(0);
      expect((await getSite(db, org.id, site.id))?.hostingRef).toBe("coolify-uuid");
    });
  });
});
```

`packages/core/src/domains/domains.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createSite } from "../sites/create-site.js";
import { createDnsRecord, deleteDnsRecord, listDnsRecords, updateDnsRecord } from "./dns-records.js";
import { createDomain, deleteDomain, listDomains, updateDomain } from "./domains.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("domains", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => { events.length = 0; setEnqueue(async (e) => { events.push(e); }); });

  it("holds a domain with no site, attaches one later and carries DNS records", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });
      const name = `acme-${crypto.randomUUID().slice(0, 8)}.test`;

      const domain = await createDomain(db, org.id, {
        clientId: client.id, name, registrar: "Namecheap", dnsProvider: "cloudflare",
        nameservers: ["ns1.cloudflare.test", "ns2.cloudflare.test"], actorKind: "user", actorId: "u1",
      });
      expect(domain.siteId).toBeNull();
      expect(domain.nameservers).toHaveLength(2);
      expect(events).toEqual([{ name: "domain.created", organisationId: org.id, domainId: domain.id }]);

      const site = await createSite(db, org.id, { clientId: client.id, name, primaryUrl: `https://${name}` });
      const attached = await updateDomain(db, org.id, { domainId: domain.id, siteId: site.id, notes: "Live" });
      expect(attached.siteId).toBe(site.id);

      const record = await createDnsRecord(db, org.id, { domainId: domain.id, type: "A", name: "@", value: "203.0.113.10" });
      await updateDnsRecord(db, org.id, { recordId: record.id, value: "203.0.113.11", ttl: 300 });
      const [saved] = await listDnsRecords(db, org.id, domain.id);
      expect(saved!.value).toBe("203.0.113.11");
      expect(saved!.ttl).toBe(300);

      const [listed] = await listDomains(db, org.id, { clientId: client.id });
      expect(listed!.clientName).toBe("Acme");
      expect(listed!.siteName).toBe(name);

      await deleteDnsRecord(db, org.id, { recordId: record.id });
      expect(await listDnsRecords(db, org.id, domain.id)).toHaveLength(0);
      await deleteDomain(db, org.id, { domainId: domain.id });
      expect(await listDomains(db, org.id, { clientId: client.id })).toHaveLength(0);
    });
  });

  it("refuses a duplicate name in the organisation and a site from another organisation", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const clientA = await createClient(db, orgA.id, { name: "Acme" });
      const clientB = await createClient(db, orgB.id, { name: "Other" });
      const siteB = await createSite(db, orgB.id, { clientId: clientB.id, name: "b", primaryUrl: "https://b.test" });
      const name = `dup-${crypto.randomUUID().slice(0, 8)}.test`;

      await createDomain(db, orgA.id, { clientId: clientA.id, name });
      await expect(createDomain(db, orgA.id, { clientId: clientA.id, name })).rejects.toThrow(`domain ${name} already exists`);
      await expect(createDomain(db, orgA.id, { clientId: clientA.id, name: `x-${name}`, siteId: siteB.id })).rejects.toThrow(
        `site ${siteB.id} not found in organisation`,
      );
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./update-site.js`, `./list-sites.js`, `./domains.js`, `./dns-records.js` not found.

- [ ] **Step 3: Implement sites**

Replace `packages/core/src/sites/create-site.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";

export const CreateSiteInput = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(200),
  primaryUrl: z.string().url(),
  platform: z.enum(["wordpress", "static", "nextjs", "other"]).default("wordpress"),
  hostingProvider: z.enum(["coolify", "other"]).default("coolify"),
  hostingRef: z.string().max(200).optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateSiteInput = z.input<typeof CreateSiteInput>;

export async function createSite(db: Db, organisationId: string, input: CreateSiteInput) {
  const { actorKind, actorId, ...fields } = CreateSiteInput.parse(input);
  await assertClientInOrganisation(db, organisationId, fields.clientId);

  const site = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [row] = await tx.insert(schema.sites).values({ organisationId, ...fields }).returning();
    await recordActivity(inner, organisationId, {
      clientId: fields.clientId, siteId: row!.id, actorKind, actorId, kind: "site.created",
      title: `Website added: ${row!.name}`, body: row!.primaryUrl, link: `/websites/${row!.id}`,
    });
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "site.created", targetType: "site", targetId: row!.id, after: row,
    });
    return row!;
  });

  await emit({ name: "site.created", organisationId, siteId: site.id });
  return site;
}
```

`packages/core/src/sites/update-site.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const UpdateSiteInput = z.object({
  siteId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  primaryUrl: z.string().url().optional(),
  platform: z.enum(["wordpress", "static", "nextjs", "other"]).optional(),
  hostingProvider: z.enum(["coolify", "other"]).optional(),
  hostingRef: z.string().max(200).nullish(),
  status: z.enum(["live", "building", "paused", "archived"]).optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type UpdateSiteInput = z.input<typeof UpdateSiteInput>;

export async function updateSite(db: Db, organisationId: string, input: UpdateSiteInput) {
  const { siteId, actorKind, actorId, ...patch } = UpdateSiteInput.parse(input);
  const where = and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.sites).where(where);
    if (!before) throw new Error(`site ${siteId} not found in organisation`);
    const [after] = await tx.update(schema.sites).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "site.updated", targetType: "site", targetId: siteId, before, after,
    });
    return after!;
  });
}
```

`packages/core/src/sites/list-sites.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { escapeLike } from "../clients/list-clients.js";

export const ListSitesInput = z.object({
  clientId: z.string().uuid().optional(),
  query: z.string().trim().max(100).optional(),
  status: z.enum(["live", "building", "paused", "archived"]).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type ListSitesInput = z.input<typeof ListSitesInput>;

export type SiteListRow = {
  id: string;
  name: string;
  primaryUrl: string;
  platform: "wordpress" | "static" | "nextjs" | "other";
  status: "live" | "building" | "paused" | "archived";
  clientId: string;
  clientName: string;
  domainCount: number;
  openIncidentCount: number;
};

export async function listSites(db: Db, organisationId: string, input: ListSitesInput = {}): Promise<SiteListRow[]> {
  const v = ListSitesInput.parse(input);
  const term = v.query ? `%${escapeLike(v.query)}%` : undefined;

  return db
    .select({
      id: schema.sites.id,
      name: schema.sites.name,
      primaryUrl: schema.sites.primaryUrl,
      platform: schema.sites.platform,
      status: schema.sites.status,
      clientId: schema.sites.clientId,
      clientName: schema.clients.name,
      domainCount: sql<number>`(select count(*)::int from ${schema.domains} where ${schema.domains.siteId} = ${schema.sites.id})`,
      openIncidentCount: sql<number>`(select count(*)::int from ${schema.incidents} where ${schema.incidents.siteId} = ${schema.sites.id} and ${schema.incidents.status} <> 'resolved')`,
    })
    .from(schema.sites)
    .innerJoin(schema.clients, eq(schema.sites.clientId, schema.clients.id))
    .where(
      and(
        eq(schema.sites.organisationId, organisationId),
        v.clientId ? eq(schema.sites.clientId, v.clientId) : undefined,
        v.status ? eq(schema.sites.status, v.status) : undefined,
        term ? or(ilike(schema.sites.name, term), ilike(schema.sites.primaryUrl, term)) : undefined,
      ),
    )
    .orderBy(asc(schema.sites.name))
    .limit(v.limit);
}

export async function getSite(db: Db, organisationId: string, siteId: string) {
  const [row] = await db
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId)));
  return row ?? null;
}
```

- [ ] **Step 4: Implement domains**

`packages/core/src/domains/domains.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { aliasedTable, and, asc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { escapeLike } from "../clients/list-clients.js";
import { emit } from "../events/emit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const ACTOR = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

// Hostnames only: no scheme, no path, no trailing dot.
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const CreateDomainInput = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().toLowerCase().max(253).regex(HOSTNAME),
  siteId: z.string().uuid().optional(),
  registrar: z.string().max(100).optional(),
  dnsProvider: z.enum(["cloudflare", "registrar", "other"]).default("other"),
  nameservers: z.array(z.string().max(253)).max(10).default([]),
  expiresAt: z.coerce.date().optional(),
  autoRenew: z.boolean().default(true),
  notes: z.string().max(4000).optional(),
  ...ACTOR,
});
export type CreateDomainInput = z.input<typeof CreateDomainInput>;

export async function createDomain(db: Db, organisationId: string, input: CreateDomainInput) {
  const { actorKind, actorId, ...fields } = CreateDomainInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, fields.clientId);
  if (fields.siteId) await assertOwned(db, organisationId, schema.sites, fields.siteId);

  // Checked explicitly so the UI gets a sentence rather than a unique-index error.
  const [clash] = await db
    .select({ id: schema.domains.id })
    .from(schema.domains)
    .where(and(eq(schema.domains.organisationId, organisationId), eq(schema.domains.name, fields.name)));
  if (clash) throw new Error(`domain ${fields.name} already exists`);

  const domain = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [row] = await tx.insert(schema.domains).values({ organisationId, ...fields }).returning();
    await recordActivity(inner, organisationId, {
      clientId: fields.clientId, siteId: fields.siteId, actorKind, actorId, kind: "domain.created",
      title: `Domain added: ${row!.name}`, link: `/domains/${row!.id}`,
    });
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "domain.created", targetType: "domain", targetId: row!.id, after: row,
    });
    return row!;
  });

  await emit({ name: "domain.created", organisationId, domainId: domain.id });
  return domain;
}

export const UpdateDomainInput = z.object({
  domainId: z.string().uuid(),
  siteId: z.string().uuid().nullish(),
  registrar: z.string().max(100).nullish(),
  dnsProvider: z.enum(["cloudflare", "registrar", "other"]).optional(),
  nameservers: z.array(z.string().max(253)).max(10).optional(),
  expiresAt: z.coerce.date().nullish(),
  autoRenew: z.boolean().optional(),
  status: z.enum(["active", "expiring", "expired", "transferring"]).optional(),
  notes: z.string().max(4000).nullish(),
  ...ACTOR,
});
export type UpdateDomainInput = z.input<typeof UpdateDomainInput>;

export async function updateDomain(db: Db, organisationId: string, input: UpdateDomainInput) {
  const { domainId, actorKind, actorId, ...patch } = UpdateDomainInput.parse(input);
  if (patch.siteId) await assertOwned(db, organisationId, schema.sites, patch.siteId);
  const where = and(eq(schema.domains.id, domainId), eq(schema.domains.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.domains).where(where);
    if (!before) throw new Error(`domain ${domainId} not found in organisation`);
    const [after] = await tx.update(schema.domains).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "domain.updated", targetType: "domain", targetId: domainId, before, after,
    });
    return after!;
  });
}

export const DeleteDomainInput = z.object({ domainId: z.string().uuid(), ...ACTOR });
export type DeleteDomainInput = z.input<typeof DeleteDomainInput>;

export async function deleteDomain(db: Db, organisationId: string, input: DeleteDomainInput): Promise<void> {
  const { domainId, actorKind, actorId } = DeleteDomainInput.parse(input);
  const where = and(eq(schema.domains.id, domainId), eq(schema.domains.organisationId, organisationId));
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.domains).where(where);
    if (!before) throw new Error(`domain ${domainId} not found in organisation`);
    await tx.delete(schema.domains).where(where); // dns_records cascade
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "domain.deleted", targetType: "domain", targetId: domainId, before,
    });
  });
}

export const ListDomainsInput = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  query: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(300).default(200),
});
export type ListDomainsInput = z.input<typeof ListDomainsInput>;

export type DomainListRow = {
  id: string;
  name: string;
  status: "active" | "expiring" | "expired" | "transferring";
  dnsProvider: "cloudflare" | "registrar" | "other";
  registrar: string | null;
  expiresAt: Date | null;
  clientId: string;
  clientName: string;
  siteId: string | null;
  siteName: string | null;
};

export async function listDomains(db: Db, organisationId: string, input: ListDomainsInput = {}): Promise<DomainListRow[]> {
  const v = ListDomainsInput.parse(input);
  const term = v.query ? `%${escapeLike(v.query)}%` : undefined;
  const site = aliasedTable(schema.sites, "domain_site");

  return db
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      status: schema.domains.status,
      dnsProvider: schema.domains.dnsProvider,
      registrar: schema.domains.registrar,
      expiresAt: schema.domains.expiresAt,
      clientId: schema.domains.clientId,
      clientName: schema.clients.name,
      siteId: schema.domains.siteId,
      siteName: site.name,
    })
    .from(schema.domains)
    .innerJoin(schema.clients, eq(schema.domains.clientId, schema.clients.id))
    .leftJoin(site, eq(schema.domains.siteId, site.id))
    .where(
      and(
        eq(schema.domains.organisationId, organisationId),
        v.clientId ? eq(schema.domains.clientId, v.clientId) : undefined,
        v.siteId ? eq(schema.domains.siteId, v.siteId) : undefined,
        term ? or(ilike(schema.domains.name, term), ilike(schema.domains.registrar, term)) : undefined,
      ),
    )
    .orderBy(asc(schema.domains.name))
    .limit(v.limit);
}

export async function getDomain(db: Db, organisationId: string, domainId: string) {
  const [row] = await db
    .select()
    .from(schema.domains)
    .where(and(eq(schema.domains.id, domainId), eq(schema.domains.organisationId, organisationId)));
  return row ?? null;
}
```

- [ ] **Step 5: Implement DNS records**

`packages/core/src/domains/dns-records.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const ACTOR = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

export const CreateDnsRecordInput = z.object({
  domainId: z.string().uuid(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]),
  name: z.string().min(1).max(253),
  value: z.string().min(1).max(1000),
  ttl: z.number().int().min(60).max(86400).default(3600),
  proxied: z.boolean().default(false),
  ...ACTOR,
});
export type CreateDnsRecordInput = z.input<typeof CreateDnsRecordInput>;

/**
 * Records what DNS *should* say. Pushing it to a provider is an approval-gated
 * agent tool (`dns_update_record`, Plan 4), never a side effect of this write.
 */
export async function createDnsRecord(db: Db, organisationId: string, input: CreateDnsRecordInput) {
  const { actorKind, actorId, ...fields } = CreateDnsRecordInput.parse(input);
  await assertOwned(db, organisationId, schema.domains, fields.domainId);
  const [row] = await db.insert(schema.dnsRecords).values({ organisationId, ...fields }).returning();
  await recordAudit(db, organisationId, {
    actorKind, actorId, action: "dns_record.created", targetType: "dns_record", targetId: row!.id, after: row,
  });
  return row!;
}

export const UpdateDnsRecordInput = z.object({
  recordId: z.string().uuid(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]).optional(),
  name: z.string().min(1).max(253).optional(),
  value: z.string().min(1).max(1000).optional(),
  ttl: z.number().int().min(60).max(86400).optional(),
  proxied: z.boolean().optional(),
  ...ACTOR,
});
export type UpdateDnsRecordInput = z.input<typeof UpdateDnsRecordInput>;

export async function updateDnsRecord(db: Db, organisationId: string, input: UpdateDnsRecordInput) {
  const { recordId, actorKind, actorId, ...patch } = UpdateDnsRecordInput.parse(input);
  const where = and(eq(schema.dnsRecords.id, recordId), eq(schema.dnsRecords.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.dnsRecords).where(where);
    if (!before) throw new Error(`dns_record ${recordId} not found in organisation`);
    const [after] = await tx.update(schema.dnsRecords).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "dns_record.updated", targetType: "dns_record", targetId: recordId, before, after,
    });
    return after!;
  });
}

export const DeleteDnsRecordInput = z.object({ recordId: z.string().uuid(), ...ACTOR });
export type DeleteDnsRecordInput = z.input<typeof DeleteDnsRecordInput>;

export async function deleteDnsRecord(db: Db, organisationId: string, input: DeleteDnsRecordInput): Promise<void> {
  const { recordId, actorKind, actorId } = DeleteDnsRecordInput.parse(input);
  const where = and(eq(schema.dnsRecords.id, recordId), eq(schema.dnsRecords.organisationId, organisationId));
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.dnsRecords).where(where);
    if (!before) throw new Error(`dns_record ${recordId} not found in organisation`);
    await tx.delete(schema.dnsRecords).where(where);
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "dns_record.deleted", targetType: "dns_record", targetId: recordId, before,
    });
  });
}

export async function listDnsRecords(db: Db, organisationId: string, domainId: string) {
  return db
    .select()
    .from(schema.dnsRecords)
    .where(and(eq(schema.dnsRecords.organisationId, organisationId), eq(schema.dnsRecords.domainId, domainId)))
    .orderBy(asc(schema.dnsRecords.type), asc(schema.dnsRecords.name));
}
```

- [ ] **Step 6: Export and run**

Append to `packages/core/src/index.ts`:
```ts
export { updateSite, UpdateSiteInput } from "./sites/update-site.js";
export { listSites, getSite, ListSitesInput } from "./sites/list-sites.js";
export type { SiteListRow } from "./sites/list-sites.js";
export {
  createDomain, updateDomain, deleteDomain, listDomains, getDomain,
  CreateDomainInput, UpdateDomainInput, DeleteDomainInput, ListDomainsInput,
} from "./domains/domains.js";
export type { DomainListRow } from "./domains/domains.js";
export {
  createDnsRecord, updateDnsRecord, deleteDnsRecord, listDnsRecords,
  CreateDnsRecordInput, UpdateDnsRecordInput, DeleteDnsRecordInput,
} from "./domains/dns-records.js";
```
Run: `pnpm --filter @launchos/core test && pnpm typecheck`
Expected: PASS (the Plan 1 agent tools call `createSite` with only `{ clientId, name, primaryUrl }`, which still type-checks because the new fields have defaults).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): site update/list, client-owned domains with nameservers and DNS record CRUD"
```

---

### Task 7: Team member services — create with a one-time password, list, deactivate

**Files:**
- Create: `packages/core/src/team/password.ts`, `packages/core/src/team/create-member.ts`, `packages/core/src/team/list-members.ts`, `packages/core/src/team/deactivate-member.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json`
- Test: `packages/core/src/team/create-member.test.ts`

**Interfaces:**
- Consumes: `recordAudit`, `notifyOwner` (Task 3), `emit` (Task 2), `schema.user` / `schema.account` / `schema.organisationMembers`, `hashPassword` from `better-auth/crypto` (the same credential shape `packages/db/src/seed.ts` writes: `providerId: "credential"`, `issuer: "local:credential"`).
- Produces:
  - `generateOneTimePassword(length?) → string`
  - `createMember(db, organisationId, { email, displayName, role, title?, phone?, invitedBy? }) → { member, oneTimePassword }` (emits `member.created`)
  - `listMembers(db, organisationId) → MemberRow[]` where `MemberRow = { id, userId, email, name, displayName, title, phone, role, status, initialPasswordSetAt, createdAt }`
  - `deactivateMember(db, organisationId, { memberId, actorId? }) → Member`

- [ ] **Step 1: Failing test**

`packages/core/src/team/create-member.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createMember } from "./create-member.js";
import { deactivateMember } from "./deactivate-member.js";
import { listMembers } from "./list-members.js";

async function makeOrgWithOwner(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const id = crypto.randomUUID();
  await db.insert(schema.user).values({ id, name: "Owner", email: `owner-${id}@example.test`, emailVerified: true });
  const [owner] = await db
    .insert(schema.organisationMembers)
    .values({ organisationId: org!.id, userId: id, role: "owner" })
    .returning();
  return { org: org!, ownerUserId: id, owner: owner! };
}

describe("createMember", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => { events.length = 0; setEnqueue(async (e) => { events.push(e); }); });

  it("creates the account with a usable one-time password and lists the member", async () => {
    await withTestDb(async (db) => {
      const { org, ownerUserId } = await makeOrgWithOwner(db);
      const email = `staff-${crypto.randomUUID()}@example.test`;

      const { member, oneTimePassword } = await createMember(db, org.id, {
        email, displayName: "Sam Staff", role: "staff", title: "Support", invitedBy: ownerUserId,
      });
      expect(oneTimePassword).toHaveLength(16);
      expect(member.status).toBe("active");
      expect(member.initialPasswordSetAt).toBeInstanceOf(Date);
      expect(events).toEqual([{ name: "member.created", organisationId: org.id, memberId: member.id }]);

      const [credential] = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, member.userId), eq(schema.account.providerId, "credential")));
      expect(credential!.issuer).toBe("local:credential");
      expect(await verifyPassword({ password: oneTimePassword, hash: credential!.password! })).toBe(true);

      const rows = await listMembers(db, org.id);
      expect(rows.map((r) => r.email)).toContain(email);
      expect(rows.find((r) => r.email === email)?.displayName).toBe("Sam Staff");

      const deactivated = await deactivateMember(db, org.id, { memberId: member.id, actorId: ownerUserId });
      expect(deactivated.status).toBe("suspended");
    });
  });

  it("refuses a second membership for the same email and refuses to remove the last owner", async () => {
    await withTestDb(async (db) => {
      const { org, owner } = await makeOrgWithOwner(db);
      const email = `staff-${crypto.randomUUID()}@example.test`;
      await createMember(db, org.id, { email, displayName: "Sam", role: "staff" });
      await expect(createMember(db, org.id, { email, displayName: "Sam again", role: "staff" })).rejects.toThrow(
        `${email} is already a member of this organisation`,
      );
      await expect(deactivateMember(db, org.id, { memberId: owner.id })).rejects.toThrow(
        "cannot deactivate the last active owner",
      );
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./create-member.js` not found (and `better-auth` is not yet a dependency of `@launchos/core`).

- [ ] **Step 3: Password generator**

Add `"better-auth": "^1.7.2"` to the `dependencies` of `packages/core/package.json` and run `pnpm install`.

`packages/core/src/team/password.ts`:
```ts
import { randomBytes } from "node:crypto";

// No 0/O/1/l/I: the password is read off a screen and typed by hand once.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/**
 * A one-time password for a newly created staff account. 16 characters from a
 * 55-symbol alphabet is ~92 bits, so the modulo bias of the byte-to-symbol map
 * is irrelevant here; this is not a long-lived secret and is never stored in
 * plain text — only its hash reaches the database.
 */
export function generateOneTimePassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}
```

- [ ] **Step 4: Implement createMember**

`packages/core/src/team/create-member.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { generateOneTimePassword } from "./password.js";

// Better Auth namespaces credential accounts as "local:<providerId>"
// (createLocalAccountIssuer in @better-auth/core/db). Same shape the seed writes.
const CREDENTIAL_PROVIDER = "credential";
const CREDENTIAL_ISSUER = `local:${CREDENTIAL_PROVIDER}`;

export const CreateMemberInput = z.object({
  email: z.string().email().trim().toLowerCase(),
  displayName: z.string().min(1).max(200),
  role: z.enum(["owner", "staff"]).default("staff"),
  title: z.string().max(100).optional(),
  phone: z.string().max(40).optional(),
  invitedBy: z.string().optional(),
});
export type CreateMemberInput = z.input<typeof CreateMemberInput>;

/**
 * Sign-up is disabled, so an account is only ever created here: the admin adds
 * the person, the returned one-time password is shown once and never stored in
 * plain text. An existing Better Auth user (a client-portal user, say) is
 * reused rather than duplicated; only their membership is new.
 */
export async function createMember(db: Db, organisationId: string, input: CreateMemberInput) {
  const v = CreateMemberInput.parse(input);
  const oneTimePassword = generateOneTimePassword();
  const passwordHash = await hashPassword(oneTimePassword);

  const member = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [existingUser] = await tx.select().from(schema.user).where(eq(schema.user.email, v.email));

    if (existingUser) {
      const [existingMember] = await tx
        .select({ id: schema.organisationMembers.id })
        .from(schema.organisationMembers)
        .where(
          and(
            eq(schema.organisationMembers.organisationId, organisationId),
            eq(schema.organisationMembers.userId, existingUser.id),
          ),
        );
      if (existingMember) throw new Error(`${v.email} is already a member of this organisation`);
    }

    const userId = existingUser?.id ?? randomUUID();
    if (!existingUser) {
      await tx.insert(schema.user).values({ id: userId, name: v.displayName, email: v.email, emailVerified: true });
    }

    const [credential] = await tx
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));
    if (credential) {
      await tx.update(schema.account).set({ password: passwordHash, updatedAt: new Date() }).where(eq(schema.account.id, credential.id));
    } else {
      await tx.insert(schema.account).values({
        id: randomUUID(),
        accountId: userId,
        providerId: CREDENTIAL_PROVIDER,
        issuer: CREDENTIAL_ISSUER,
        userId,
        password: passwordHash,
      });
    }

    const [row] = await tx
      .insert(schema.organisationMembers)
      .values({
        organisationId,
        userId,
        displayName: v.displayName,
        title: v.title ?? null,
        phone: v.phone ?? null,
        invitedBy: v.invitedBy ?? null,
        initialPasswordSetAt: new Date(),
        role: v.role,
        status: "active",
      })
      .returning();

    await recordAudit(inner, organisationId, {
      actorKind: "user",
      actorId: v.invitedBy,
      action: "member.created",
      targetType: "organisation_member",
      targetId: row!.id,
      // The password hash is never audited, and the plain password never leaves this call.
      after: { id: row!.id, userId, email: v.email, role: row!.role, displayName: row!.displayName },
    });
    return row!;
  });

  await notifyOwner(db, organisationId, {
    kind: "member.created",
    title: `Team member added: ${v.displayName}`,
    body: v.email,
    link: "/team",
  });
  await emit({ name: "member.created", organisationId, memberId: member.id });
  return { member, oneTimePassword };
}
```

- [ ] **Step 5: Implement list and deactivate**

`packages/core/src/team/list-members.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";

export type MemberRow = {
  id: string;
  userId: string;
  email: string;
  name: string;
  displayName: string | null;
  title: string | null;
  phone: string | null;
  role: "owner" | "staff";
  status: "active" | "invited" | "suspended";
  initialPasswordSetAt: Date | null;
  createdAt: Date;
};

export async function listMembers(db: Db, organisationId: string): Promise<MemberRow[]> {
  return db
    .select({
      id: schema.organisationMembers.id,
      userId: schema.organisationMembers.userId,
      email: schema.user.email,
      name: schema.user.name,
      displayName: schema.organisationMembers.displayName,
      title: schema.organisationMembers.title,
      phone: schema.organisationMembers.phone,
      role: schema.organisationMembers.role,
      status: schema.organisationMembers.status,
      initialPasswordSetAt: schema.organisationMembers.initialPasswordSetAt,
      createdAt: schema.organisationMembers.createdAt,
    })
    .from(schema.organisationMembers)
    .innerJoin(schema.user, eq(schema.organisationMembers.userId, schema.user.id))
    .where(eq(schema.organisationMembers.organisationId, organisationId))
    .orderBy(asc(schema.organisationMembers.createdAt));
}

/** Active owners, used to stop the last one being locked out. */
export async function countActiveOwners(db: Db, organisationId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.organisationMembers.id })
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.role, "owner"),
        eq(schema.organisationMembers.status, "active"),
      ),
    );
  return rows.length;
}
```

`packages/core/src/team/deactivate-member.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { countActiveOwners } from "./list-members.js";

export const DeactivateMemberInput = z.object({ memberId: z.string().uuid(), actorId: z.string().optional() });
export type DeactivateMemberInput = z.input<typeof DeactivateMemberInput>;

/**
 * Suspends rather than deletes: `getSession` only accepts active memberships,
 * so a suspended member is signed out on their next request while their audit
 * trail stays attributable.
 */
export async function deactivateMember(db: Db, organisationId: string, input: DeactivateMemberInput) {
  const v = DeactivateMemberInput.parse(input);
  const where = and(
    eq(schema.organisationMembers.id, v.memberId),
    eq(schema.organisationMembers.organisationId, organisationId),
  );

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.organisationMembers).where(where);
    if (!before) throw new Error(`organisation_member ${v.memberId} not found in organisation`);
    if (before.role === "owner" && before.status === "active" && (await countActiveOwners(inner, organisationId)) <= 1) {
      throw new Error("cannot deactivate the last active owner");
    }
    const [after] = await tx
      .update(schema.organisationMembers)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(where)
      .returning();
    await recordAudit(inner, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "member.deactivated",
      targetType: "organisation_member", targetId: v.memberId, before, after,
    });
    return after!;
  });
}
```

- [ ] **Step 6: Export and run**

Append to `packages/core/src/index.ts`:
```ts
export { generateOneTimePassword } from "./team/password.js";
export { createMember, CreateMemberInput } from "./team/create-member.js";
export { listMembers, countActiveOwners } from "./team/list-members.js";
export type { MemberRow } from "./team/list-members.js";
export { deactivateMember, DeactivateMemberInput } from "./team/deactivate-member.js";
```
Run: `pnpm --filter @launchos/core test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): team members created with a one-time password, listed and deactivated safely"
```

---

### Task 8: Global search service and the `/api/search` route

**Files:**
- Create: `packages/core/src/search/search.ts`, `apps/web/src/app/api/search/route.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/search/search.test.ts`

**Interfaces:**
- Consumes: `escapeLike` (Task 4), `schema.clients` / `sites` / `domains` / `tickets`.
- Produces:
  - `search(db, organisationId, { q, limit? }) → SearchResults`
  - `type SearchResults = { clients: {id,name,slug}[]; sites: {id,name,primaryUrl}[]; domains: {id,name}[]; tickets: {id,subject,status}[] }`
  - `GET /api/search?q=` → `SearchResults` JSON for the signed-in session's organisation; `401` when signed out; empty result sets for a query under 2 characters.

- [ ] **Step 1: Failing test**

`packages/core/src/search/search.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { createSite } from "../sites/create-site.js";
import { createDomain } from "../domains/domains.js";
import { createTicket } from "../support/create-ticket.js";
import { search } from "./search.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("search", () => {
  it("matches clients, sites, domains and tickets in the organisation only", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const token = crypto.randomUUID().slice(0, 8);

      const client = await createClient(db, orgA.id, { name: `Cabline ${token}` });
      const site = await createSite(db, orgA.id, { clientId: client.id, name: `site-${token}`, primaryUrl: `https://${token}.test` });
      await createDomain(db, orgA.id, { clientId: client.id, name: `${token}.test`, siteId: site.id });
      await createTicket(db, orgA.id, { clientId: client.id, subject: `Broken ${token}`, body: "b", source: "manual" });

      const hits = await search(db, orgA.id, { q: token });
      expect(hits.clients).toHaveLength(1);
      expect(hits.sites).toHaveLength(1);
      expect(hits.domains).toHaveLength(1);
      expect(hits.tickets).toHaveLength(1);
      expect(hits.clients[0]!.slug).toBe(client.slug);

      const none = await search(db, orgB.id, { q: token });
      expect(none).toEqual({ clients: [], sites: [], domains: [], tickets: [] });
    });
  });

  it("treats % as a literal, not a wildcard", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await createClient(db, org.id, { name: "Acme" });
      expect((await search(db, org.id, { q: "%" })).clients).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @launchos/core test`
Expected: FAIL — `./search.js` not found.

- [ ] **Step 3: Implement search**

`packages/core/src/search/search.ts`:
```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { escapeLike } from "../clients/list-clients.js";

export const SearchInput = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(20).default(5),
});
export type SearchInput = z.input<typeof SearchInput>;

export type SearchResults = {
  clients: { id: string; name: string; slug: string }[];
  sites: { id: string; name: string; primaryUrl: string }[];
  domains: { id: string; name: string }[];
  tickets: { id: string; subject: string; status: string }[];
};

/**
 * Header search: name/subject ILIKE, organisation-scoped, a handful of rows per
 * kind. Tasks join this in Plan 3 and knowledge articles in Plan 4.
 */
export async function search(db: Db, organisationId: string, input: SearchInput): Promise<SearchResults> {
  const v = SearchInput.parse(input);
  const term = `%${escapeLike(v.q)}%`;

  const [clients, sites, domains, tickets] = await Promise.all([
    db
      .select({ id: schema.clients.id, name: schema.clients.name, slug: schema.clients.slug })
      .from(schema.clients)
      .where(
        and(
          eq(schema.clients.organisationId, organisationId),
          or(ilike(schema.clients.name, term), ilike(schema.clients.slug, term), ilike(schema.clients.email, term)),
        ),
      )
      .orderBy(asc(schema.clients.name))
      .limit(v.limit),
    db
      .select({ id: schema.sites.id, name: schema.sites.name, primaryUrl: schema.sites.primaryUrl })
      .from(schema.sites)
      .where(
        and(
          eq(schema.sites.organisationId, organisationId),
          or(ilike(schema.sites.name, term), ilike(schema.sites.primaryUrl, term)),
        ),
      )
      .orderBy(asc(schema.sites.name))
      .limit(v.limit),
    db
      .select({ id: schema.domains.id, name: schema.domains.name })
      .from(schema.domains)
      .where(and(eq(schema.domains.organisationId, organisationId), ilike(schema.domains.name, term)))
      .orderBy(asc(schema.domains.name))
      .limit(v.limit),
    db
      .select({ id: schema.tickets.id, subject: schema.tickets.subject, status: schema.tickets.status })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.organisationId, organisationId), ilike(schema.tickets.subject, term)))
      .orderBy(asc(schema.tickets.subject))
      .limit(v.limit),
  ]);

  return { clients, sites, domains, tickets };
}
```

- [ ] **Step 4: The API route**

`apps/web/src/app/api/search/route.ts`:
```ts
import { search, type SearchResults } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const EMPTY: SearchResults = { clients: [], sites: [], domains: [], tickets: [] };
const MIN_QUERY_LENGTH = 2;

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < MIN_QUERY_LENGTH || q.length > 100) return NextResponse.json(EMPTY);

  const results = await search(getDb(), session.organisationId, { q });
  return NextResponse.json(results);
}
```

- [ ] **Step 5: Export, run, commit**

Append to `packages/core/src/index.ts`:
```ts
export { search, SearchInput } from "./search/search.js";
export type { SearchResults } from "./search/search.js";
```
Run: `pnpm --filter @launchos/core test && pnpm --filter @launchos/web typecheck`
Expected: PASS.
```bash
git add -A
git commit -m "feat(core,web): organisation-scoped global search service behind /api/search"
```

---

### Task 9: Admin shell — grouped sidebar, header search, notifications bell

**Files:**
- Create: `apps/web/src/lib/nav.ts`, `apps/web/src/components/app-nav.tsx`, `apps/web/src/components/global-search.tsx`, `apps/web/src/components/notifications-bell.tsx`, `apps/web/src/components/form-fields.tsx`, `apps/web/src/app/(admin)/notifications/actions.ts`
- Modify: `apps/web/src/app/(admin)/layout.tsx`, `apps/web/package.json`
- Test: `apps/web/tests/e2e/admin-shell.spec.ts`

**Interfaces:**
- Consumes: `requireAdmin()` / `AdminSession` (`apps/web/src/lib/session.ts`), `getDb()` (`apps/web/src/lib/db.ts`), `listNotifications` / `countUnreadNotifications` / `markNotificationRead` / `markAllNotificationsRead` (Task 3), `GET /api/search` (Task 8).
- Produces:
  - `NAV_GROUPS: readonly NavGroup[]`, `type NavItem = { label: string; href: string; plan?: 3 | 4 | 5 }`, `type NavGroup = { label: string; items: readonly NavItem[] }`
  - `<AppNav groups={NAV_GROUPS} email={...} role={...} />` — desktop aside plus a drawer under 1024px
  - `<GlobalSearch />` — header input hitting `/api/search?q=`
  - `<NotificationsBell session={...} />` — server component with unread count, list and mark-read actions
  - `<TextField />`, `<SelectField />`, `<TextAreaField />` — react-hook-form bound inputs used by Tasks 10 and 11
  - `markOneRead(formData)`, `markAllRead()` server actions

- [ ] **Step 1: Failing e2e for the shell**

`apps/web/tests/e2e/admin-shell.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

test("the shell shows the grouped nav, later plans disabled, and search finds a seeded client", async ({ page }) => {
  await signIn(page);

  await expect(page.getByRole("navigation").getByRole("link", { name: "Clients" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Websites" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Domains" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Team" })).toBeVisible();
  await expect(page.getByRole("navigation").getByText("Tasks")).toHaveAttribute("title", "Arrives in Plan 3");

  await page.getByRole("searchbox", { name: "Search" }).fill("Grays");
  await expect(page.getByRole("link", { name: /Grays CabLine/ }).first()).toBeVisible();

  await expect(page.getByRole("button", { name: /Notifications/ })).toBeVisible();
});
```

`apps/web/tests/e2e/sign-in.ts` (shared helper; the Plan 1 spec keeps its own inline steps):
```ts
import { expect, type Page } from "@playwright/test";

export async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(process.env.SEED_OWNER_EMAIL ?? "shujaat@nexusedu.co.uk");
  await page.getByLabel("Password").fill(process.env.SEED_OWNER_PASSWORD ?? "change-me-now");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The form redirects once the session cookie is set; navigating earlier lands back on /sign-in.
  await page.waitForURL("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/web exec playwright test admin-shell` (with `pnpm db:seed` already applied)
Expected: FAIL — there is no Clients link, no search box and no notifications button.

- [ ] **Step 3: Dependencies and shadcn components**

Run from `apps/web`:
```bash
pnpm add react-hook-form @hookform/resolvers
pnpm dlx shadcn@latest add dialog input label select textarea tabs sonner separator
```
Expected: `src/components/ui/{dialog,input,label,select,textarea,tabs,sonner,separator}.tsx` created; `sonner` and `@radix-ui`-backed packages added by the CLI.

- [ ] **Step 4: The navigation model**

`apps/web/src/lib/nav.ts`:
```ts
export type NavItem = { label: string; href: string; plan?: 3 | 4 | 5 };
export type NavGroup = { label: string; items: readonly NavItem[] };

/**
 * The final admin navigation (spec §5). Items whose module arrives in a later
 * plan render as disabled labels rather than links to routes that 404.
 * "Open Cases" is the spec's name for the ticket list Plan 1 already ships.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { label: "Overview", items: [{ label: "Dashboard", href: "/" }] },
  {
    label: "Delivery",
    items: [
      { label: "Clients", href: "/clients" },
      { label: "Websites", href: "/websites" },
      { label: "Domains", href: "/domains" },
      { label: "Tasks", href: "/tasks", plan: 3 },
    ],
  },
  {
    label: "Support",
    items: [
      { label: "Inbox", href: "/inbox", plan: 4 },
      { label: "Open Cases", href: "/tickets" },
      { label: "Incidents", href: "/incidents" },
    ],
  },
  {
    label: "Money",
    items: [
      { label: "Payments", href: "/payments", plan: 5 },
      { label: "Invoices", href: "/invoices", plan: 5 },
      { label: "Ads", href: "/ads", plan: 5 },
    ],
  },
  {
    label: "Automation",
    items: [
      { label: "Approvals", href: "/approvals" },
      { label: "Agents", href: "/settings/agents" },
      { label: "Knowledge Base", href: "/knowledge", plan: 4 },
    ],
  },
  {
    label: "Organisation",
    items: [
      { label: "Team", href: "/team" },
      { label: "Settings", href: "/settings/organisation" },
    ],
  },
];
```

- [ ] **Step 5: Sidebar**

`apps/web/src/components/app-nav.tsx`:
```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { NavGroup } from "@/lib/nav";
import { cn } from "@/lib/utils";

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ groups, onNavigate }: { groups: readonly NavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto p-3">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{group.label}</p>
          <div className="space-y-0.5">
            {group.items.map((item) =>
              item.plan ? (
                <span
                  key={item.label}
                  title={`Arrives in Plan ${item.plan}`}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-neutral-400"
                >
                  {item.label}
                  <span className="text-[10px] uppercase tracking-wide">Plan {item.plan}</span>
                </span>
              ) : (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={isActive(pathname, item.href) ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-3 py-2 text-sm transition-colors",
                    isActive(pathname, item.href)
                      ? "bg-neutral-100 font-medium text-neutral-900"
                      : "text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900",
                  )}
                >
                  {item.label}
                </Link>
              ),
            )}
          </div>
        </div>
      ))}
    </nav>
  );
}

function Identity({ email, role }: { email: string; role: string }) {
  return (
    <div className="border-t border-neutral-200 px-5 py-4 text-xs text-neutral-500">
      <p className="truncate font-medium text-neutral-700">{email}</p>
      <p className="mt-0.5 capitalize">{role}</p>
    </div>
  );
}

export function AppNav({ groups, email, role }: { groups: readonly NavGroup[]; email: string; role: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer whenever the route changes, so a tap-through does not
  // leave the overlay covering the page it just opened.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-neutral-200 bg-white lg:flex">
        <div className="border-b border-neutral-200 px-5 py-4">
          <p className="text-sm font-semibold tracking-tight text-neutral-900">LaunchOS</p>
          <p className="mt-0.5 text-xs text-neutral-500">Admin portal</p>
        </div>
        <NavList groups={groups} />
        <Identity email={email} role={role} />
      </aside>

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-700 lg:hidden"
      >
        Menu
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="flex w-72 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
              <p className="text-sm font-semibold tracking-tight text-neutral-900">LaunchOS</p>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="text-sm text-neutral-500">
                Close
              </button>
            </div>
            <NavList groups={groups} onNavigate={() => setOpen(false)} />
            <Identity email={email} role={role} />
          </div>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="flex-1 cursor-default bg-neutral-900/20"
          />
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 6: Header search**

`apps/web/src/components/global-search.tsx`:
```tsx
"use client";

import type { SearchResults } from "@launchos/core";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const EMPTY: SearchResults = { clients: [], sites: [], domains: [], tickets: [] };
const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.trim().length < MIN_QUERY_LENGTH) {
      setResults(EMPTY);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        setResults(response.ok ? ((await response.json()) as SearchResults) : EMPTY);
      } catch {
        // Aborted by the next keystroke, or the request failed: keep the last
        // rendered results rather than flashing an error into the header.
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const groups = [
    { label: "Clients", rows: results.clients.map((c) => ({ id: c.id, label: c.name, hint: c.slug, href: `/clients/${c.id}` })) },
    { label: "Websites", rows: results.sites.map((s) => ({ id: s.id, label: s.name, hint: s.primaryUrl, href: `/websites/${s.id}` })) },
    { label: "Domains", rows: results.domains.map((d) => ({ id: d.id, label: d.name, hint: "", href: `/domains/${d.id}` })) },
    { label: "Open cases", rows: results.tickets.map((t) => ({ id: t.id, label: t.subject, hint: t.status, href: "/tickets" })) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <input
        type="search"
        aria-label="Search"
        placeholder="Search clients, websites, domains, cases"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setResults(EMPTY), 150)}
        className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
      />
      {groups.length > 0 ? (
        <div className="absolute left-0 right-0 top-11 z-40 max-h-96 overflow-y-auto rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
          {groups.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{group.label}</p>
              {group.rows.map((row) => (
                <Link
                  key={row.id}
                  href={row.href}
                  onClick={() => {
                    setQuery("");
                    setResults(EMPTY);
                  }}
                  className="block rounded-md px-2 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100"
                >
                  {row.label}
                  {row.hint ? <span className="ml-2 text-xs text-neutral-400">{row.hint}</span> : null}
                </Link>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 7: Notifications bell**

`apps/web/src/app/(admin)/notifications/actions.ts`:
```ts
"use server";

import { markAllNotificationsRead, markNotificationRead } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const MarkOne = z.object({ notificationId: z.string().uuid() });

export async function markOneRead(formData: FormData): Promise<void> {
  // Server Actions accept direct POSTs: authorise here, and scope the write to
  // this user's own notifications inside the service.
  const session = await requireAdmin();
  const { notificationId } = MarkOne.parse({ notificationId: formData.get("notificationId") });
  await markNotificationRead(getDb(), session.organisationId, { userId: session.userId, notificationId });
  revalidatePath("/", "layout");
}

export async function markAllRead(): Promise<void> {
  const session = await requireAdmin();
  await markAllNotificationsRead(getDb(), session.organisationId, session.userId);
  revalidatePath("/", "layout");
}
```

`apps/web/src/components/notifications-bell.tsx`:
```tsx
import { countUnreadNotifications, listNotifications } from "@launchos/core";
import Link from "next/link";
import { markAllRead, markOneRead } from "@/app/(admin)/notifications/actions";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import type { AdminSession } from "@/lib/session";

const LIST_LIMIT = 10;

/**
 * A `<details>` dropdown rather than a popover: the list is server-rendered on
 * every request, so the count can never drift from the rows below it.
 */
export async function NotificationsBell({ session }: { session: AdminSession }) {
  const db = getDb();
  const [unread, rows] = await Promise.all([
    countUnreadNotifications(db, session.organisationId, session.userId),
    listNotifications(db, session.organisationId, { userId: session.userId, limit: LIST_LIMIT }),
  ]);

  return (
    <details className="relative">
      <summary
        role="button"
        aria-label={`Notifications, ${unread} unread`}
        className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-700"
      >
        Notifications
        {unread > 0 ? (
          <span className="rounded-full bg-neutral-900 px-1.5 text-[11px] font-medium tabular-nums text-white">{unread}</span>
        ) : null}
      </summary>

      <div className="absolute right-0 top-11 z-40 w-80 rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
        {rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-neutral-500">Nothing to read.</p>
        ) : (
          <>
            {rows.map((row) => (
              <div key={row.id} className="rounded-md px-2 py-2 hover:bg-neutral-50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {row.link ? (
                      <Link href={row.link} className="block truncate text-sm font-medium text-neutral-900 hover:underline">
                        {row.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm font-medium text-neutral-900">{row.title}</p>
                    )}
                    {row.body ? <p className="mt-0.5 truncate text-xs text-neutral-500">{row.body}</p> : null}
                    <p className="mt-0.5 text-[11px] text-neutral-400">{formatDateTime(row.createdAt)}</p>
                  </div>
                  {row.readAt ? null : (
                    <form action={markOneRead}>
                      <input type="hidden" name="notificationId" value={row.id} />
                      <button type="submit" className="text-xs text-neutral-500 hover:text-neutral-900">
                        Mark read
                      </button>
                    </form>
                  )}
                </div>
              </div>
            ))}
            {unread > 0 ? (
              <form action={markAllRead} className="border-t border-neutral-200 pt-2">
                <button type="submit" className="w-full rounded-md px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100">
                  Mark all read
                </button>
              </form>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}
```

- [ ] **Step 8: Shared form fields and the rebuilt layout**

`apps/web/src/components/form-fields.tsx`:
```tsx
"use client";

import type { ReactNode } from "react";
import type { FieldError, FieldValues, Path, UseFormRegister } from "react-hook-form";

type FieldProps<T extends FieldValues> = {
  name: Path<T>;
  label: string;
  register: UseFormRegister<T>;
  error?: FieldError;
  type?: string;
  placeholder?: string;
  required?: boolean;
};

const CONTROL =
  "h-9 w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none";

function Wrapper({ name, label, error, children }: { name: string; label: string; error?: FieldError; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-neutral-700">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}

export function TextField<T extends FieldValues>({ name, label, register, error, type = "text", placeholder, required }: FieldProps<T>) {
  return (
    <Wrapper name={name} label={label} error={error}>
      <input id={name} type={type} placeholder={placeholder} required={required} className={CONTROL} {...register(name)} />
    </Wrapper>
  );
}

export function TextAreaField<T extends FieldValues>({ name, label, register, error, placeholder }: FieldProps<T>) {
  return (
    <Wrapper name={name} label={label} error={error}>
      <textarea id={name} rows={3} placeholder={placeholder} className={`${CONTROL} h-auto py-2`} {...register(name)} />
    </Wrapper>
  );
}

export function SelectField<T extends FieldValues>({
  name, label, register, error, options,
}: FieldProps<T> & { options: readonly { value: string; label: string }[] }) {
  return (
    <Wrapper name={name} label={label} error={error}>
      <select id={name} className={CONTROL} {...register(name)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Wrapper>
  );
}
```

Replace `apps/web/src/app/(admin)/layout.tsx`:
```tsx
import { Toaster } from "@/components/ui/sonner";
import { AppNav } from "@/components/app-nav";
import { GlobalSearch } from "@/components/global-search";
import { NotificationsBell } from "@/components/notifications-bell";
import { NAV_GROUPS } from "@/lib/nav";
import { requireAdmin } from "@/lib/session";

// The whole admin shell reads the session, so nothing here is prerenderable.
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const session = await requireAdmin();

  return (
    <div className="flex min-h-screen flex-1 bg-neutral-50">
      <AppNav groups={NAV_GROUPS} email={session.email} role={session.role} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3">
          <GlobalSearch />
          <div className="ml-auto">
            <NotificationsBell session={session} />
          </div>
        </header>

        <main className="flex-1 px-6 py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>

        <footer className="border-t border-neutral-200 bg-white px-6 py-4 text-xs text-neutral-500">
          Powered by LaunchFlow
        </footer>
        <Toaster position="top-right" richColors />
      </div>
    </div>
  );
}
```
The mobile menu button lives inside `AppNav`, which the header row renders on small screens; move `<AppNav .../>` into the header's leading slot if the button should sit beside the search box rather than above it.

- [ ] **Step 9: Run the e2e and commit**

Run: `pnpm --filter @launchos/web typecheck && pnpm --filter @launchos/web exec playwright test admin-shell`
Expected: PASS (the Clients/Websites/Domains/Team routes do not exist yet, so only the links are asserted, not their targets).
```bash
git add -A
git commit -m "feat(web): rebuilt admin shell with grouped navigation, global search and a notifications bell"
```

---

### Task 10: Clients list, New client dialog and the client detail tabs

**Files:**
- Create: `apps/web/src/app/(admin)/clients/page.tsx`, `apps/web/src/app/(admin)/clients/schemas.ts`, `apps/web/src/app/(admin)/clients/actions.ts`, `apps/web/src/app/(admin)/clients/new-client-dialog.tsx`, `apps/web/src/app/(admin)/clients/[id]/page.tsx`, `apps/web/src/app/(admin)/clients/[id]/tabs.tsx`, `apps/web/src/app/(admin)/clients/[id]/forms.tsx`
- Test: `apps/web/tests/e2e/admin-clients.spec.ts`

**Interfaces:**
- Consumes: `listClients`, `getClient`, `createClient`, `updateClient`, `archiveClient` (Task 4); `listContacts`, `createContact`, `deleteContact`, `upsertBillingProfile`, `getBillingProfile` (Task 5); `listSites`, `createSite`, `listDomains`, `createDomain` (Task 6); `listActivity` (Task 3); `installWebEnqueue` (Task 4); `TextField` / `TextAreaField` / `SelectField` (Task 9).
- Produces:
  - `NewClientSchema`, `NewContactSchema`, `NewDomainSchema`, `NewSiteSchema`, `BillingSchema` and their `z.input<>` value types (client-safe, no server imports)
  - server actions `createClientAction(values) → { status: "ok"; clientId } | { status: "error"; message }`, `archiveClientAction(formData)`, `createContactAction(values) → ActionResult`, `deleteContactAction(formData)`, `saveBillingAction(values) → ActionResult`, `createSiteAction(values) → ActionResult`, `createDomainAction(values) → ActionResult`
  - routes `/clients` (search + status filter + New client) and `/clients/[id]?tab=overview|contacts|sites|portal`

- [ ] **Step 1: Failing e2e**

`apps/web/tests/e2e/admin-clients.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

test("create a client, add a contact, two domains and a site, then find it in search", async ({ page }) => {
  const stamp = Date.now();
  const name = `E2E Client ${stamp}`;

  await signIn(page);
  await page.getByRole("navigation").getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();

  await page.getByRole("button", { name: "New client" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(`e2e-${stamp}@example.test`);
  await page.getByLabel("Phone").fill("01375 000000");
  await page.getByLabel("Address line 1").fill("1 High Street");
  await page.getByLabel("City").fill("Grays");
  await page.getByLabel("Postcode").fill("RM17 6AA");
  await page.getByRole("button", { name: "Create client" }).click();

  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText(`e2e-client-${stamp}@`)).toBeVisible();

  await page.getByRole("link", { name: "Contacts & Billing" }).click();
  await page.getByLabel("Contact name").fill("Alex Contact");
  await page.getByLabel("Contact email").fill(`alex-${stamp}@example.test`);
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByRole("cell", { name: "Alex Contact" })).toBeVisible();

  await page.getByRole("link", { name: "Sites & Domains" }).click();
  for (const suffix of ["one", "two"]) {
    await page.getByLabel("Domain name").fill(`${suffix}-${stamp}.example.test`);
    await page.getByRole("button", { name: "Add domain" }).click();
    await expect(page.getByRole("cell", { name: `${suffix}-${stamp}.example.test` })).toBeVisible();
  }

  await page.getByLabel("Website name").fill(`site-${stamp}`);
  await page.getByLabel("Primary URL").fill(`https://one-${stamp}.example.test`);
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page.getByRole("cell", { name: `site-${stamp}` })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search" }).fill(name);
  await expect(page.getByRole("link", { name })).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/web exec playwright test admin-clients`
Expected: FAIL — `/clients` 404s.

- [ ] **Step 3: Shared schemas**

`apps/web/src/app/(admin)/clients/schemas.ts`:
```ts
import { z } from "zod";

// Shared by the client-side resolver and the server action, so one definition
// validates on both sides. Empty strings from untouched inputs become undefined
// rather than failing an email/url check.
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalEmail = z.preprocess(blankToUndefined, z.string().email().optional());
const optionalUrl = z.preprocess(blankToUndefined, z.string().url().optional());

export const NewClientSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: optionalEmail,
  phone: optionalText(40),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  postcode: optionalText(20),
  websiteUrl: optionalUrl,
  industry: optionalText(100),
});
export type NewClientValues = z.input<typeof NewClientSchema>;

export const NewContactSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(200),
  email: optionalEmail,
  phone: optionalText(40),
  role: optionalText(100),
  isPrimary: z.boolean().default(false),
});
export type NewContactValues = z.input<typeof NewContactSchema>;

export const BillingSchema = z.object({
  clientId: z.string().uuid(),
  billingName: optionalText(200),
  addressLine1: optionalText(200),
  city: optionalText(100),
  postcode: optionalText(20),
  vatNumber: optionalText(40),
  paymentTermsDays: z.coerce.number().int().min(0).max(180),
  preferredMethod: optionalText(100),
});
export type BillingValues = z.input<typeof BillingSchema>;

export const NewSiteSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(200),
  primaryUrl: z.string().url("Must be a full URL"),
  platform: z.enum(["wordpress", "static", "nextjs", "other"]).default("wordpress"),
});
export type NewSiteValues = z.input<typeof NewSiteSchema>;

export const NewDomainSchema = z.object({
  clientId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, "Hostname only, no scheme or path"),
  registrar: optionalText(100),
  dnsProvider: z.enum(["cloudflare", "registrar", "other"]).default("other"),
});
export type NewDomainValues = z.input<typeof NewDomainSchema>;

export type ActionResult = { status: "ok"; id: string } | { status: "error"; message: string };
```

- [ ] **Step 4: Server actions**

`apps/web/src/app/(admin)/clients/actions.ts`:
```ts
"use server";

import {
  archiveClient, createClient, createContact, createDomain, createSite, deleteContact, upsertBillingProfile,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";
import {
  BillingSchema, NewClientSchema, NewContactSchema, NewDomainSchema, NewSiteSchema,
  type ActionResult, type BillingValues, type NewClientValues, type NewContactValues, type NewDomainValues, type NewSiteValues,
} from "./schemas";

/** Turns a service throw into a message the dialog can show, never a 500 page. */
function failed(error: unknown): ActionResult {
  return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
}

export async function createClientAction(values: NewClientValues): Promise<ActionResult> {
  // Server Actions accept direct POSTs: authorise, then re-validate the same
  // schema the browser used.
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = NewClientSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid details" };

  try {
    const client = await createClient(getDb(), session.organisationId, {
      ...parsed.data,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath("/clients");
    return { status: "ok", id: client.id };
  } catch (error) {
    return failed(error);
  }
}

const ArchiveInput = z.object({ clientId: z.string().uuid() });

export async function archiveClientAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const { clientId } = ArchiveInput.parse({ clientId: formData.get("clientId") });
  await archiveClient(getDb(), session.organisationId, { clientId, actorKind: "user", actorId: session.userId });
  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`);
}

export async function createContactAction(values: NewContactValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = NewContactSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid contact" };
  try {
    const contact = await createContact(getDb(), session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: contact.id };
  } catch (error) {
    return failed(error);
  }
}

const DeleteContactFormInput = z.object({ contactId: z.string().uuid(), clientId: z.string().uuid() });

export async function deleteContactAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const { contactId, clientId } = DeleteContactFormInput.parse({
    contactId: formData.get("contactId"),
    clientId: formData.get("clientId"),
  });
  await deleteContact(getDb(), session.organisationId, { contactId, actorKind: "user", actorId: session.userId });
  revalidatePath(`/clients/${clientId}`);
}

export async function saveBillingAction(values: BillingValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = BillingSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid billing details" };
  try {
    const profile = await upsertBillingProfile(getDb(), session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: profile.id };
  } catch (error) {
    return failed(error);
  }
}

export async function createSiteAction(values: NewSiteValues): Promise<ActionResult> {
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = NewSiteSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid website" };
  try {
    const site = await createSite(getDb(), session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    revalidatePath("/websites");
    return { status: "ok", id: site.id };
  } catch (error) {
    return failed(error);
  }
}

export async function createDomainAction(values: NewDomainValues): Promise<ActionResult> {
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = NewDomainSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid domain" };
  try {
    const domain = await createDomain(getDb(), session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    revalidatePath("/domains");
    return { status: "ok", id: domain.id };
  } catch (error) {
    return failed(error);
  }
}
```

- [ ] **Step 5: New client dialog**

`apps/web/src/app/(admin)/clients/new-client-dialog.tsx`:
```tsx
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createClientAction } from "./actions";
import { NewClientSchema, type NewClientValues } from "./schemas";

export function NewClientDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<NewClientValues>({ resolver: zodResolver(NewClientSchema), defaultValues: { name: "" } });

  async function onSubmit(values: NewClientValues) {
    const result = await createClientAction(values);
    if (result.status === "error") {
      toast.error(result.message);
      return;
    }
    toast.success(`${values.name} created`);
    setOpen(false);
    reset();
    router.push(`/clients/${result.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New client</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <TextField name="name" label="Name" register={register} error={errors.name} required />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="email" label="Email" type="email" register={register} error={errors.email} />
            <TextField name="phone" label="Phone" register={register} error={errors.phone} />
          </div>
          <TextField name="addressLine1" label="Address line 1" register={register} error={errors.addressLine1} />
          <TextField name="addressLine2" label="Address line 2" register={register} error={errors.addressLine2} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="city" label="City" register={register} error={errors.city} />
            <TextField name="postcode" label="Postcode" register={register} error={errors.postcode} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="websiteUrl" label="Website" placeholder="https://" register={register} error={errors.websiteUrl} />
            <TextField name="industry" label="Industry" register={register} error={errors.industry} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create client"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Clients list**

`apps/web/src/app/(admin)/clients/page.tsx`:
```tsx
import { listClients } from "@launchos/core";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { NewClientDialog } from "./new-client-dialog";

export const dynamic = "force-dynamic";

const STATUSES = ["all", "active", "paused", "archived"] as const;

export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const statusParam = typeof params.status === "string" ? params.status : "active";
  const status = STATUSES.includes(statusParam as (typeof STATUSES)[number]) ? statusParam : "active";

  const rows = await listClients(getDb(), session.organisationId, {
    query,
    status: status === "all" ? undefined : (status as "active" | "paused" | "archived"),
  });

  return (
    <>
      <PageHeader
        title="Clients"
        description="Every client, their support address, websites and domains."
        actions={<NewClientDialog />}
      />

      <form className="mb-4 flex flex-wrap items-end gap-2" action="/clients">
        <div className="space-y-1.5">
          <label htmlFor="q" className="block text-xs font-medium text-neutral-500">
            Search
          </label>
          <input
            id="q"
            name="q"
            defaultValue={query ?? ""}
            placeholder="Name, slug or email"
            className="h-9 w-64 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="status" className="block text-xs font-medium text-neutral-500">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status}
            className="h-9 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value === "all" ? "All" : value}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="h-9 rounded-md border border-neutral-300 px-3 text-sm text-neutral-700 hover:bg-neutral-100">
          Apply
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyState>No clients match. Use “New client” to add the first one.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Support address</TableHead>
                <TableHead className="text-right">Websites</TableHead>
                <TableHead className="text-right">Domains</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/clients/${row.id}`} className="font-medium text-neutral-900 hover:underline">
                      {row.name}
                    </Link>
                    <span className="block text-xs text-neutral-400">{row.email ?? row.slug}</span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                  <TableCell className="text-neutral-600">{row.supportEmail ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">{row.siteCount}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">{row.domainCount}</TableCell>
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
`StatusBadge` already maps `active`/`paused`/`archived` to the neutral tone by falling through its lookup; add `active: "success"`, `paused: "warn"`, `archived: "neutral"` to `TONE_BY_VALUE` in `apps/web/src/components/status-badge.tsx` so client rows read at a glance.

- [ ] **Step 7: Client detail tabs and inline forms**

`apps/web/src/app/(admin)/clients/[id]/tabs.tsx`:
```tsx
import Link from "next/link";
import { cn } from "@/lib/utils";

export const CLIENT_TABS = [
  { key: "overview", label: "Overview" },
  { key: "contacts", label: "Contacts & Billing" },
  { key: "sites", label: "Sites & Domains" },
  { key: "portal", label: "Portal users" },
] as const;

export type ClientTabKey = (typeof CLIENT_TABS)[number]["key"];

// Tasks, Support, Invoices and Reports tabs arrive with Plans 3, 4 and 5.
const LATER_TABS = [
  { label: "Tasks", plan: 3 },
  { label: "Support", plan: 4 },
  { label: "Invoices", plan: 5 },
  { label: "Reports", plan: 5 },
] as const;

export function ClientTabs({ clientId, active }: { clientId: string; active: ClientTabKey }) {
  return (
    <div className="mb-6 flex flex-wrap gap-1 border-b border-neutral-200">
      {CLIENT_TABS.map((tab) => (
        <Link
          key={tab.key}
          href={`/clients/${clientId}?tab=${tab.key}`}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm",
            tab.key === active
              ? "border-neutral-900 font-medium text-neutral-900"
              : "border-transparent text-neutral-500 hover:text-neutral-900",
          )}
        >
          {tab.label}
        </Link>
      ))}
      {LATER_TABS.map((tab) => (
        <span key={tab.label} title={`Arrives in Plan ${tab.plan}`} className="px-3 py-2 text-sm text-neutral-300">
          {tab.label}
        </span>
      ))}
    </div>
  );
}
```

`apps/web/src/app/(admin)/clients/[id]/forms.tsx` — one client component holding the three inline "add" forms and the billing form, all react-hook-form + the shared Zod schemas:
```tsx
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { SelectField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { createContactAction, createDomainAction, createSiteAction, saveBillingAction } from "../actions";
import {
  BillingSchema, NewContactSchema, NewDomainSchema, NewSiteSchema,
  type BillingValues, type NewContactValues, type NewDomainValues, type NewSiteValues,
} from "../schemas";

export function AddContactForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<NewContactValues>({
    resolver: zodResolver(NewContactSchema),
    defaultValues: { clientId, name: "", isPrimary: false },
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await createContactAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Contact added");
        reset({ clientId, name: "", isPrimary: false });
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <TextField name="name" label="Contact name" register={register} error={errors.name} required />
      <TextField name="email" label="Contact email" type="email" register={register} error={errors.email} />
      <TextField name="phone" label="Contact phone" register={register} error={errors.phone} />
      <div className="flex items-end">
        <Button type="submit" disabled={isSubmitting} className="w-full">
          Add contact
        </Button>
      </div>
    </form>
  );
}

export function AddDomainForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<NewDomainValues>({
    resolver: zodResolver(NewDomainSchema),
    defaultValues: { clientId, name: "", dnsProvider: "other" },
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await createDomainAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Domain added");
        reset({ clientId, name: "", dnsProvider: "other" });
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <TextField name="name" label="Domain name" placeholder="example.co.uk" register={register} error={errors.name} required />
      <TextField name="registrar" label="Registrar" register={register} error={errors.registrar} />
      <SelectField
        name="dnsProvider"
        label="DNS provider"
        register={register}
        error={errors.dnsProvider}
        options={[
          { value: "other", label: "Other" },
          { value: "cloudflare", label: "Cloudflare" },
          { value: "registrar", label: "Registrar" },
        ]}
      />
      <div className="flex items-end">
        <Button type="submit" disabled={isSubmitting} className="w-full">
          Add domain
        </Button>
      </div>
    </form>
  );
}

export function AddSiteForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<NewSiteValues>({
    resolver: zodResolver(NewSiteSchema),
    defaultValues: { clientId, name: "", primaryUrl: "", platform: "wordpress" },
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await createSiteAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Website added");
        reset({ clientId, name: "", primaryUrl: "", platform: "wordpress" });
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <TextField name="name" label="Website name" register={register} error={errors.name} required />
      <TextField name="primaryUrl" label="Primary URL" placeholder="https://" register={register} error={errors.primaryUrl} required />
      <SelectField
        name="platform"
        label="Platform"
        register={register}
        error={errors.platform}
        options={[
          { value: "wordpress", label: "WordPress" },
          { value: "nextjs", label: "Next.js" },
          { value: "static", label: "Static" },
          { value: "other", label: "Other" },
        ]}
      />
      <div className="flex items-end">
        <Button type="submit" disabled={isSubmitting} className="w-full">
          Add website
        </Button>
      </div>
    </form>
  );
}

export function BillingForm({ clientId, defaults }: { clientId: string; defaults: Omit<BillingValues, "clientId"> }) {
  const router = useRouter();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<BillingValues>({
    resolver: zodResolver(BillingSchema),
    defaultValues: { clientId, ...defaults },
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={handleSubmit(async (values) => {
        const result = await saveBillingAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Billing details saved");
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <TextField name="billingName" label="Billing name" register={register} error={errors.billingName} />
      <TextField name="vatNumber" label="VAT number" register={register} error={errors.vatNumber} />
      <TextField name="addressLine1" label="Billing address" register={register} error={errors.addressLine1} />
      <TextField name="city" label="Billing city" register={register} error={errors.city} />
      <TextField name="postcode" label="Billing postcode" register={register} error={errors.postcode} />
      <TextField name="paymentTermsDays" label="Payment terms (days)" type="number" register={register} error={errors.paymentTermsDays} />
      <TextField name="preferredMethod" label="Preferred method" register={register} error={errors.preferredMethod} />
      <div className="flex items-end">
        <Button type="submit" disabled={isSubmitting}>
          Save billing details
        </Button>
      </div>
    </form>
  );
}
```
No card or bank fields exist in `BillingSchema`, and none may be added: see the Global Constraints.

- [ ] **Step 8: Client detail page**

`apps/web/src/app/(admin)/clients/[id]/page.tsx`:
```tsx
import { getBillingProfile, getClient, listActivity, listContacts, listDomains, listSites } from "@launchos/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { archiveClientAction, deleteContactAction } from "../actions";
import { AddContactForm, AddDomainForm, AddSiteForm, BillingForm } from "./forms";
import { CLIENT_TABS, ClientTabs, type ClientTabKey } from "./tabs";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params, searchParams }: PageProps<"/clients/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const session = await requireAdmin();
  const db = getDb();

  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const requested = typeof query.tab === "string" ? query.tab : "overview";
  const tab: ClientTabKey = CLIENT_TABS.some((t) => t.key === requested) ? (requested as ClientTabKey) : "overview";

  return (
    <>
      <PageHeader
        title={client.name}
        description={`${client.supportEmail ?? "no support address"} · ${[client.city, client.postcode].filter(Boolean).join(" ") || "no address"}`}
        actions={
          <form action={archiveClientAction}>
            <input type="hidden" name="clientId" value={client.id} />
            <Button type="submit" variant="outline" disabled={client.status === "archived"}>
              Archive
            </Button>
          </form>
        }
      />

      <ClientTabs clientId={client.id} active={tab} />

      {tab === "overview" ? <OverviewTab clientId={client.id} /> : null}
      {tab === "contacts" ? <ContactsTab clientId={client.id} /> : null}
      {tab === "sites" ? <SitesTab clientId={client.id} /> : null}
      {tab === "portal" ? (
        <EmptyState>Portal users arrive in Plan 4, together with the client portal itself.</EmptyState>
      ) : null}
    </>
  );
}

async function OverviewTab({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const events = await listActivity(getDb(), session.organisationId, { clientId });

  if (events.length === 0) return <EmptyState>Nothing has happened yet. Add a contact, a domain or a website.</EmptyState>;

  return (
    <ol className="space-y-3">
      {events.map((event) => (
        <li key={event.id} className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-neutral-900">
              {event.link ? (
                <Link href={event.link} className="hover:underline">
                  {event.title}
                </Link>
              ) : (
                event.title
              )}
            </p>
            <p className="text-xs text-neutral-400">
              {formatDateTime(event.createdAt)} · {event.actorKind}
            </p>
          </div>
          {event.body ? <p className="mt-1 text-sm text-neutral-600">{event.body}</p> : null}
        </li>
      ))}
    </ol>
  );
}

async function ContactsTab({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const db = getDb();
  const [contacts, billing] = await Promise.all([
    listContacts(db, session.organisationId, clientId),
    getBillingProfile(db, session.organisationId, clientId),
  ]);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Contacts</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
          <AddContactForm clientId={clientId} />
        </div>
        {contacts.length === 0 ? (
          <EmptyState>No contacts yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((contact) => (
                  <TableRow key={contact.id}>
                    <TableCell className="font-medium text-neutral-900">
                      {contact.name}
                      {contact.isPrimary ? <StatusBadge value="primary" tone="info" /> : null}
                    </TableCell>
                    <TableCell className="text-neutral-600">{contact.email ?? "—"}</TableCell>
                    <TableCell className="text-neutral-600">{contact.phone ?? "—"}</TableCell>
                    <TableCell className="text-neutral-600">{contact.role ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <form action={deleteContactAction}>
                        <input type="hidden" name="contactId" value={contact.id} />
                        <input type="hidden" name="clientId" value={clientId} />
                        <button type="submit" className="text-xs text-neutral-500 hover:text-red-600">
                          Remove
                        </button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Billing</h2>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <BillingForm
            clientId={clientId}
            defaults={{
              billingName: billing?.billingName ?? "",
              addressLine1: billing?.addressLine1 ?? "",
              city: billing?.city ?? "",
              postcode: billing?.postcode ?? "",
              vatNumber: billing?.vatNumber ?? "",
              paymentTermsDays: billing?.paymentTermsDays ?? 14,
              preferredMethod: billing?.preferredMethod ?? "",
            }}
          />
          <p className="mt-3 text-xs text-neutral-400">
            Card and bank numbers are never stored. Payment methods live with Stripe from Plan 5.
          </p>
        </div>
      </section>
    </div>
  );
}

async function SitesTab({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const db = getDb();
  const [sites, domains] = await Promise.all([
    listSites(db, session.organisationId, { clientId }),
    listDomains(db, session.organisationId, { clientId }),
  ]);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Websites</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
          <AddSiteForm clientId={clientId} />
        </div>
        {sites.length === 0 ? (
          <EmptyState>No websites yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Website</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead className="text-right">Domains</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((site) => (
                  <TableRow key={site.id}>
                    <TableCell>
                      <Link href={`/websites/${site.id}`} className="font-medium text-neutral-900 hover:underline">
                        {site.name}
                      </Link>
                      <span className="block text-xs text-neutral-400">{site.primaryUrl}</span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={site.status} />
                    </TableCell>
                    <TableCell className="text-neutral-600">{site.platform}</TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-600">{site.domainCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Domains</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
          <AddDomainForm clientId={clientId} />
        </div>
        {domains.length === 0 ? (
          <EmptyState>No domains yet. A domain can be added before its website exists.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>DNS</TableHead>
                  <TableHead>Website</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((domain) => (
                  <TableRow key={domain.id}>
                    <TableCell>
                      <Link href={`/domains/${domain.id}`} className="font-medium text-neutral-900 hover:underline">
                        {domain.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={domain.status} />
                    </TableCell>
                    <TableCell className="text-neutral-600">{domain.dnsProvider}</TableCell>
                    <TableCell className="text-neutral-600">{domain.siteName ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(domain.expiresAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 9: Run the e2e and commit**

Run: `pnpm --filter @launchos/web typecheck && pnpm --filter @launchos/web exec playwright test admin-clients`
Expected: PASS.
```bash
git add -A
git commit -m "feat(web): clients list with search and filters, New client dialog and client detail tabs"
```

---

### Task 11: Websites and Domains screens with DNS records

**Files:**
- Create: `apps/web/src/app/(admin)/websites/page.tsx`, `apps/web/src/app/(admin)/websites/[id]/page.tsx`, `apps/web/src/app/(admin)/domains/page.tsx`, `apps/web/src/app/(admin)/domains/[id]/page.tsx`, `apps/web/src/app/(admin)/domains/actions.ts`, `apps/web/src/app/(admin)/domains/schemas.ts`, `apps/web/src/app/(admin)/domains/[id]/dns-form.tsx`

**Interfaces:**
- Consumes: `listSites`, `getSite`, `listDomains`, `getDomain`, `updateDomain`, `listDnsRecords`, `createDnsRecord`, `deleteDnsRecord` (Task 6), `getClient` (Task 4), `schema.monitors` / `schema.incidents` (Plan 1), `TextField` / `SelectField` (Task 9).
- Produces:
  - `NewDnsRecordSchema` + `NewDnsRecordValues`, `AttachSiteSchema`
  - server actions `createDnsRecordAction(values) → ActionResult`, `deleteDnsRecordAction(formData)`, `attachDomainToSiteAction(formData)`
  - routes `/websites`, `/websites/[id]`, `/domains`, `/domains/[id]`

- [ ] **Step 1: Failing check — the routes the shell already links to**

Run: `pnpm dev`, then open `http://localhost:3000/websites` and `http://localhost:3000/domains`.
Expected: both 404. The nav links Task 9 added point at pages that do not exist yet; this task creates them, and Task 10's `admin-clients` spec already asserts the `/websites/[id]` and `/domains/[id]` links it renders.

- [ ] **Step 2: DNS schemas and actions**

`apps/web/src/app/(admin)/domains/schemas.ts`:
```ts
import { z } from "zod";

export const NewDnsRecordSchema = z.object({
  domainId: z.string().uuid(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]).default("A"),
  name: z.string().trim().min(1, "Name is required").max(253),
  value: z.string().trim().min(1, "Value is required").max(1000),
  ttl: z.coerce.number().int().min(60).max(86400).default(3600),
});
export type NewDnsRecordValues = z.input<typeof NewDnsRecordSchema>;

export const AttachSiteSchema = z.object({
  domainId: z.string().uuid(),
  siteId: z.union([z.literal(""), z.string().uuid()]),
});
```

`apps/web/src/app/(admin)/domains/actions.ts`:
```ts
"use server";

import { createDnsRecord, deleteDnsRecord, updateDomain } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import type { ActionResult } from "../clients/schemas";
import { AttachSiteSchema, NewDnsRecordSchema, type NewDnsRecordValues } from "./schemas";

export async function createDnsRecordAction(values: NewDnsRecordValues): Promise<ActionResult> {
  // Server Actions accept direct POSTs: authorise, then re-validate.
  const session = await requireAdmin();
  const parsed = NewDnsRecordSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid record" };
  try {
    const record = await createDnsRecord(getDb(), session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/domains/${parsed.data.domainId}`);
    return { status: "ok", id: record.id };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
  }
}

const DeleteRecordInput = z.object({ recordId: z.string().uuid(), domainId: z.string().uuid() });

export async function deleteDnsRecordAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const { recordId, domainId } = DeleteRecordInput.parse({
    recordId: formData.get("recordId"),
    domainId: formData.get("domainId"),
  });
  await deleteDnsRecord(getDb(), session.organisationId, { recordId, actorKind: "user", actorId: session.userId });
  revalidatePath(`/domains/${domainId}`);
}

export async function attachDomainToSiteAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const { domainId, siteId } = AttachSiteSchema.parse({
    domainId: formData.get("domainId"),
    siteId: formData.get("siteId") ?? "",
  });
  await updateDomain(getDb(), session.organisationId, {
    domainId,
    siteId: siteId === "" ? null : siteId,
    actorKind: "user",
    actorId: session.userId,
  });
  revalidatePath(`/domains/${domainId}`);
  revalidatePath("/domains");
}
```

- [ ] **Step 3: DNS record form**

`apps/web/src/app/(admin)/domains/[id]/dns-form.tsx`:
```tsx
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { SelectField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { createDnsRecordAction } from "../actions";
import { NewDnsRecordSchema, type NewDnsRecordValues } from "../schemas";

const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"].map((value) => ({ value, label: value }));

export function AddDnsRecordForm({ domainId }: { domainId: string }) {
  const router = useRouter();
  const defaults: NewDnsRecordValues = { domainId, type: "A", name: "@", value: "", ttl: 3600 };
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<NewDnsRecordValues>({
    resolver: zodResolver(NewDnsRecordSchema),
    defaultValues: defaults,
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-5"
      onSubmit={handleSubmit(async (values) => {
        const result = await createDnsRecordAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("DNS record saved");
        reset(defaults);
        router.refresh();
      })}
    >
      <input type="hidden" {...register("domainId")} />
      <SelectField name="type" label="Type" register={register} error={errors.type} options={TYPES} />
      <TextField name="name" label="Record name" register={register} error={errors.name} required />
      <TextField name="value" label="Value" register={register} error={errors.value} required />
      <TextField name="ttl" label="TTL" type="number" register={register} error={errors.ttl} />
      <div className="flex items-end">
        <Button type="submit" disabled={isSubmitting} className="w-full">
          Add record
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Websites list and detail**

`apps/web/src/app/(admin)/websites/page.tsx`:
```tsx
import { listSites } from "@launchos/core";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function WebsitesPage({ searchParams }: PageProps<"/websites">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const rows = await listSites(getDb(), session.organisationId, { query });

  return (
    <>
      <PageHeader title="Websites" description="Every site we build, host or look after." />

      <form className="mb-4" action="/websites">
        <label htmlFor="q" className="sr-only">
          Search websites
        </label>
        <input
          id="q"
          name="q"
          defaultValue={query ?? ""}
          placeholder="Name or URL"
          className="h-9 w-72 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
        />
      </form>

      {rows.length === 0 ? (
        <EmptyState>No websites yet. Add one from a client’s “Sites &amp; Domains” tab.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Website</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead className="text-right">Domains</TableHead>
                <TableHead className="text-right">Open incidents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/websites/${row.id}`} className="font-medium text-neutral-900 hover:underline">
                      {row.name}
                    </Link>
                    <span className="block text-xs text-neutral-400">{row.primaryUrl}</span>
                  </TableCell>
                  <TableCell>
                    <Link href={`/clients/${row.clientId}`} className="text-neutral-700 hover:underline">
                      {row.clientName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                  <TableCell className="text-neutral-600">{row.platform}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">{row.domainCount}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">{row.openIncidentCount}</TableCell>
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

`apps/web/src/app/(admin)/websites/[id]/page.tsx`:
```tsx
import { getClient, getSite, listDnsRecords, listDomains } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const INCIDENT_LIMIT = 10;

export default async function WebsiteDetailPage({ params }: PageProps<"/websites/[id]">) {
  const { id } = await params;
  const session = await requireAdmin();
  const db = getDb();

  const site = await getSite(db, session.organisationId, id);
  if (!site) notFound();

  const [client, domains, monitors, incidents] = await Promise.all([
    getClient(db, session.organisationId, site.clientId),
    listDomains(db, session.organisationId, { siteId: site.id }),
    db
      .select()
      .from(schema.monitors)
      .where(and(eq(schema.monitors.organisationId, session.organisationId), eq(schema.monitors.siteId, site.id))),
    db
      .select({
        id: schema.incidents.id,
        title: schema.incidents.title,
        status: schema.incidents.status,
        severity: schema.incidents.severity,
        openedAt: schema.incidents.openedAt,
      })
      .from(schema.incidents)
      .where(and(eq(schema.incidents.organisationId, session.organisationId), eq(schema.incidents.siteId, site.id)))
      .orderBy(desc(schema.incidents.openedAt))
      .limit(INCIDENT_LIMIT),
  ]);

  // One flat DNS table across every domain pointed at this site; editing lives
  // on the domain page, which owns the records.
  const dnsByDomain = await Promise.all(
    domains.map(async (domain) => ({
      domain,
      records: await listDnsRecords(db, session.organisationId, domain.id),
    })),
  );

  return (
    <>
      <PageHeader
        title={site.name}
        description={site.primaryUrl}
        actions={
          client ? (
            <Link href={`/clients/${client.id}`} className="text-sm text-neutral-700 underline">
              {client.name}
            </Link>
          ) : null
        }
      />

      <dl className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Status</dt>
          <dd className="mt-1">
            <StatusBadge value={site.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Platform</dt>
          <dd className="mt-1 text-neutral-700">{site.platform}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Hosting</dt>
          <dd className="mt-1 text-neutral-700">{site.hostingProvider}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Hosting ref</dt>
          <dd className="mt-1 truncate text-neutral-700">{site.hostingRef ?? "—"}</dd>
        </div>
      </dl>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Domains</h2>
        {domains.length === 0 ? (
          <EmptyState>No domain points at this website yet.</EmptyState>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {domains.map((domain) => (
              <li key={domain.id}>
                <Link
                  href={`/domains/${domain.id}`}
                  className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-800 hover:border-neutral-300"
                >
                  {domain.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">DNS records</h2>
        {dnsByDomain.every((entry) => entry.records.length === 0) ? (
          <EmptyState>No DNS records recorded. Add them on the domain page.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="text-right">TTL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dnsByDomain.flatMap((entry) =>
                  entry.records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell className="text-neutral-600">{entry.domain.name}</TableCell>
                      <TableCell className="font-medium text-neutral-900">{record.type}</TableCell>
                      <TableCell className="text-neutral-600">{record.name}</TableCell>
                      <TableCell className="max-w-xs truncate text-neutral-600">{record.value}</TableCell>
                      <TableCell className="text-right tabular-nums text-neutral-600">{record.ttl}</TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">Monitors</h2>
          {monitors.length === 0 ? (
            <p className="text-sm text-neutral-500">No monitor watches this site.</p>
          ) : (
            <ul className="space-y-1 text-sm text-neutral-700">
              {monitors.map((monitor) => (
                <li key={monitor.id} className="flex justify-between gap-2">
                  <span className="truncate">{monitor.target}</span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    every {monitor.intervalSeconds}s · {monitor.consecutiveFailures} failures
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">Recent incidents</h2>
          {incidents.length === 0 ? (
            <p className="text-sm text-neutral-500">No incidents recorded.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {incidents.map((incident) => (
                <li key={incident.id} className="flex items-center justify-between gap-2">
                  <Link href={`/incidents/${incident.id}`} className="truncate text-neutral-800 hover:underline">
                    {incident.title}
                  </Link>
                  <span className="flex shrink-0 items-center gap-1">
                    <StatusBadge value={incident.status} />
                    <span className="text-xs text-neutral-400">{formatDateTime(incident.openedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
```

- [ ] **Step 5: Domains list and detail**

`apps/web/src/app/(admin)/domains/page.tsx`:
```tsx
import { listDomains } from "@launchos/core";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DomainsPage({ searchParams }: PageProps<"/domains">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const rows = await listDomains(getDb(), session.organisationId, { query });

  return (
    <>
      <PageHeader title="Domains" description="Every domain bought for or assigned to a client." />

      <form className="mb-4" action="/domains">
        <label htmlFor="q" className="sr-only">
          Search domains
        </label>
        <input
          id="q"
          name="q"
          defaultValue={query ?? ""}
          placeholder="Domain or registrar"
          className="h-9 w-72 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
        />
      </form>

      {rows.length === 0 ? (
        <EmptyState>No domains yet. Add one from a client’s “Sites &amp; Domains” tab.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Website</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>DNS</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/domains/${row.id}`} className="font-medium text-neutral-900 hover:underline">
                      {row.name}
                    </Link>
                    <span className="block text-xs text-neutral-400">{row.registrar ?? "registrar unknown"}</span>
                  </TableCell>
                  <TableCell>
                    <Link href={`/clients/${row.clientId}`} className="text-neutral-700 hover:underline">
                      {row.clientName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    {row.siteId ? (
                      <Link href={`/websites/${row.siteId}`} className="hover:underline">
                        {row.siteName}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                  <TableCell className="text-neutral-600">{row.dnsProvider}</TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(row.expiresAt)}</TableCell>
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

`apps/web/src/app/(admin)/domains/[id]/page.tsx`:
```tsx
import { getClient, getDomain, listDnsRecords, listSites } from "@launchos/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { attachDomainToSiteAction, deleteDnsRecordAction } from "../actions";
import { AddDnsRecordForm } from "./dns-form";

export const dynamic = "force-dynamic";

export default async function DomainDetailPage({ params }: PageProps<"/domains/[id]">) {
  const { id } = await params;
  const session = await requireAdmin();
  const db = getDb();

  const domain = await getDomain(db, session.organisationId, id);
  if (!domain) notFound();

  const [client, sites, records] = await Promise.all([
    getClient(db, session.organisationId, domain.clientId),
    listSites(db, session.organisationId, { clientId: domain.clientId }),
    listDnsRecords(db, session.organisationId, domain.id),
  ]);

  return (
    <>
      <PageHeader
        title={domain.name}
        description={client ? `${client.name} · ${domain.registrar ?? "registrar unknown"}` : undefined}
        actions={
          client ? (
            <Link href={`/clients/${client.id}`} className="text-sm text-neutral-700 underline">
              {client.name}
            </Link>
          ) : null
        }
      />

      <dl className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Status</dt>
          <dd className="mt-1">
            <StatusBadge value={domain.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">DNS provider</dt>
          <dd className="mt-1 text-neutral-700">{domain.dnsProvider}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Expires</dt>
          <dd className="mt-1 text-neutral-700">{formatDateTime(domain.expiresAt)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Nameservers</dt>
          <dd className="mt-1 text-neutral-700">{domain.nameservers.length > 0 ? domain.nameservers.join(", ") : "—"}</dd>
        </div>
      </dl>

      <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Website</h2>
        <form action={attachDomainToSiteAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="domainId" value={domain.id} />
          <div className="space-y-1.5">
            <label htmlFor="siteId" className="block text-sm font-medium text-neutral-700">
              Points at
            </label>
            <select
              id="siteId"
              name="siteId"
              defaultValue={domain.siteId ?? ""}
              className="h-9 w-64 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
            >
              <option value="">Not assigned</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="outline">
            Save
          </Button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">DNS records</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
          <AddDnsRecordForm domainId={domain.id} />
          <p className="mt-3 text-xs text-neutral-400">
            This records what DNS should say. Pushing changes to a provider is an approval-gated agent action from Plan 4.
          </p>
        </div>
        {records.length === 0 ? (
          <EmptyState>No DNS records recorded for this domain.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="text-right">TTL</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="font-medium text-neutral-900">{record.type}</TableCell>
                    <TableCell className="text-neutral-600">{record.name}</TableCell>
                    <TableCell className="max-w-md truncate text-neutral-600">{record.value}</TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-600">{record.ttl}</TableCell>
                    <TableCell className="text-right">
                      <form action={deleteDnsRecordAction}>
                        <input type="hidden" name="recordId" value={record.id} />
                        <input type="hidden" name="domainId" value={domain.id} />
                        <button type="submit" className="text-xs text-neutral-500 hover:text-red-600">
                          Remove
                        </button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @launchos/web typecheck && pnpm --filter @launchos/web build && pnpm --filter @launchos/web exec playwright test admin-clients`
Expected: PASS, and the `/websites/[id]` and `/domains/[id]` links the client detail page renders now resolve.
```bash
git add -A
git commit -m "feat(web): websites and domains screens with DNS records, monitors and incident links"
```

---

### Task 12: Team, Settings → Organisation, seed, docs and the full check

**Files:**
- Create: `apps/web/src/app/(admin)/team/page.tsx`, `apps/web/src/app/(admin)/team/actions.ts`, `apps/web/src/app/(admin)/team/add-member-dialog.tsx`, `apps/web/src/app/(admin)/settings/organisation/page.tsx`
- Modify: `packages/db/src/seed.ts`, `docs/MODULE_MAP.md`, `docs/DATA_MODEL.md`, `README.md`
- Test: `apps/web/tests/e2e/admin-team.spec.ts`

**Interfaces:**
- Consumes: `listMembers`, `createMember`, `deactivateMember` (Task 7), `supportEmailDomain` (Task 4), `createContact` / `upsertBillingProfile` (Task 5), `createDomain` (Task 6), `recordActivity` (Task 3), `TextField` / `SelectField` (Task 9).
- Produces:
  - `type AddMemberState = { status: "idle" } | { status: "error"; message: string } | { status: "created"; email: string; displayName: string; oneTimePassword: string }`
  - `addMemberAction(prev: AddMemberState, formData: FormData) → Promise<AddMemberState>` (for `useActionState`), `deactivateMemberAction(formData)`
  - routes `/team` and `/settings/organisation`
  - a seed that produces slugs, support emails, two contacts per client, billing profiles, three domains (one unattached), one staff member and a few activity events

- [ ] **Step 1: Failing e2e**

`apps/web/tests/e2e/admin-team.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

test("add a team member and see the one-time password exactly once", async ({ page }) => {
  const email = `e2e-staff-${Date.now()}@example.test`;

  await signIn(page);
  await page.getByRole("navigation").getByRole("link", { name: "Team" }).click();
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();

  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByLabel("Full name").fill("E2E Staff");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Create member" }).click();

  const password = page.getByTestId("one-time-password");
  await expect(password).toBeVisible();
  await expect(password).not.toHaveText("");

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: email })).toBeVisible();

  // Shown once only: reloading the page must not reveal it again.
  await page.reload();
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @launchos/web exec playwright test admin-team`
Expected: FAIL — `/team` 404s.

- [ ] **Step 3: Team server actions**

`apps/web/src/app/(admin)/team/actions.ts`:
```ts
"use server";

import { createMember, deactivateMember } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";

export type AddMemberState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; email: string; displayName: string; oneTimePassword: string };

const AddMemberInput = z.object({
  displayName: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().toLowerCase().email("A valid email is required"),
  role: z.enum(["owner", "staff"]).default("staff"),
  title: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().max(100).optional()),
});

/**
 * Returns the one-time password in the action result and nowhere else: it is
 * never persisted in plain text, never revalidated into a page, and never
 * logged. Reloading the Team page cannot show it again.
 */
export async function addMemberAction(_prev: AddMemberState, formData: FormData): Promise<AddMemberState> {
  // Server Actions accept direct POSTs: authorise first. Only an owner may
  // create accounts, since a new account can be an owner.
  const session = await requireAdmin();
  if (session.role !== "owner") return { status: "error", message: "Only an owner can add team members" };
  installWebEnqueue();

  const parsed = AddMemberInput.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    role: formData.get("role") ?? "staff",
    title: formData.get("title") ?? undefined,
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid details" };

  try {
    const { oneTimePassword } = await createMember(getDb(), session.organisationId, {
      ...parsed.data,
      invitedBy: session.userId,
    });
    revalidatePath("/team");
    return {
      status: "created",
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      oneTimePassword,
    };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not add the member" };
  }
}

const DeactivateInput = z.object({ memberId: z.string().uuid() });

export async function deactivateMemberAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  if (session.role !== "owner") throw new Error("Only an owner can deactivate team members");
  const { memberId } = DeactivateInput.parse({ memberId: formData.get("memberId") });
  await deactivateMember(getDb(), session.organisationId, { memberId, actorId: session.userId });
  revalidatePath("/team");
}
```

- [ ] **Step 4: Add member dialog**

`apps/web/src/app/(admin)/team/add-member-dialog.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { addMemberAction, type AddMemberState } from "./actions";

const INITIAL: AddMemberState = { status: "idle" };

export function AddMemberDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(addMemberAction, INITIAL);

  function close() {
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button>Add member</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{state.status === "created" ? "Member added" : "Add team member"}</DialogTitle>
        </DialogHeader>

        {state.status === "created" ? (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              {state.displayName} can sign in with <span className="font-medium text-neutral-900">{state.email}</span> and this
              one-time password. It is shown once and cannot be retrieved again — send it to them now and ask them to change it.
            </p>
            <p
              data-testid="one-time-password"
              className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-center font-mono text-base tracking-widest text-neutral-900"
            >
              {state.oneTimePassword}
            </p>
            <div className="flex justify-end">
              <Button type="button" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form action={formAction} className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="displayName" className="block text-sm font-medium text-neutral-700">
                Full name
              </label>
              <input
                id="displayName"
                name="displayName"
                required
                className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-sm font-medium text-neutral-700">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="title" className="block text-sm font-medium text-neutral-700">
                Job title
              </label>
              <input
                id="title"
                name="title"
                className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="role" className="block text-sm font-medium text-neutral-700">
                Role
              </label>
              <select
                id="role"
                name="role"
                defaultValue="staff"
                className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
              >
                <option value="staff">Staff</option>
                <option value="owner">Owner</option>
              </select>
            </div>

            {state.status === "error" ? (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {state.message}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Creating…" : "Create member"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Team page and Settings → Organisation**

`apps/web/src/app/(admin)/team/page.tsx`:
```tsx
import { listMembers } from "@launchos/core";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { deactivateMemberAction } from "./actions";
import { AddMemberDialog } from "./add-member-dialog";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const session = await requireAdmin();
  const members = await listMembers(getDb(), session.organisationId);
  const isOwner = session.role === "owner";

  return (
    <>
      <PageHeader
        title="Team"
        description="People who can sign in and be assigned work. Sign-up is disabled: accounts are created here."
        actions={isOwner ? <AddMemberDialog /> : null}
      />

      {members.length === 0 ? (
        <EmptyState>No members yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Added</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium text-neutral-900">
                    {member.displayName ?? member.name}
                    {member.title ? <span className="block text-xs text-neutral-400">{member.title}</span> : null}
                  </TableCell>
                  <TableCell className="text-neutral-600">{member.email}</TableCell>
                  <TableCell className="capitalize text-neutral-600">{member.role}</TableCell>
                  <TableCell>
                    <StatusBadge value={member.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(member.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {isOwner && member.status === "active" && member.userId !== session.userId ? (
                      <form action={deactivateMemberAction}>
                        <input type="hidden" name="memberId" value={member.id} />
                        <button type="submit" className="text-xs text-neutral-500 hover:text-red-600">
                          Deactivate
                        </button>
                      </form>
                    ) : null}
                  </TableCell>
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
Add `invited: "info"` and `suspended: "neutral"` to `TONE_BY_VALUE` in `apps/web/src/components/status-badge.tsx`.

`apps/web/src/app/(admin)/settings/organisation/page.tsx`:
```tsx
import { supportEmailDomain } from "@launchos/core";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OrganisationSettingsPage() {
  const session = await requireAdmin();
  const [organisation] = await getDb()
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.id, session.organisationId));
  if (!organisation) notFound();

  return (
    <>
      <PageHeader title="Organisation" description="Who this LaunchOS runs for, and where client mail lands." />

      <dl className="grid grid-cols-1 gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Name</dt>
          <dd className="mt-1 text-neutral-900">{organisation.name}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Slug</dt>
          <dd className="mt-1 text-neutral-700">{organisation.slug}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Status</dt>
          <dd className="mt-1">
            <StatusBadge value={organisation.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Created</dt>
          <dd className="mt-1 text-neutral-700">{formatDateTime(organisation.createdAt)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Support email domain</dt>
          <dd className="mt-1 text-neutral-900">
            <code className="rounded bg-neutral-100 px-1.5 py-0.5">{supportEmailDomain()}</code>
            <span className="ml-2 text-xs text-neutral-500">
              Every client address is <code>slug@{supportEmailDomain()}</code>. Change it with the{" "}
              <code>SUPPORT_EMAIL_DOMAIN</code> environment variable; inbound routing arrives in Plan 4.
            </span>
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-sm text-neutral-500">
        Agent enablement lives on{" "}
        <Link href="/settings/agents" className="underline">
          Settings → Agents
        </Link>
        .
      </p>
    </>
  );
}
```
Add `active: "success"` and `suspended: "neutral"` coverage to `StatusBadge` (already done in Task 10 / this step) so the organisation status renders green.

- [ ] **Step 6: Extend the seed**

`packages/db/src/seed.ts` — extend `SEED_CLIENTS` with contacts and domains, add the staff member, billing profiles and a few timeline entries. Add to the existing constants:
```ts
const STAFF = { email: "team@launchflow.example", name: "Sam Staff", title: "Support" } as const;

const SEED_CLIENTS = [
  {
    name: "Grays CabLine",
    slug: "grays-cabline",
    email: "info@grayscabline.co.uk",
    url: "https://grayscabline.co.uk",
    contacts: [
      { name: "Shoji", email: "shujaat@nexusedu.co.uk", role: "Owner", isPrimary: true },
      { name: "Dispatch desk", email: "dispatch@grayscabline.co.uk", role: "Operations", isPrimary: false },
    ],
    // The third domain deliberately has no site: a domain can be bought first.
    domains: ["grayscabline.co.uk", "grayscabline.com"],
  },
  {
    name: "Mobile PC Doctor",
    slug: "mobile-pc-doctor",
    email: "info@mobilepcdoctor.co.uk",
    url: "https://mobilepcdoctor.co.uk",
    contacts: [
      { name: "Shoji", email: "shujaat@nexusedu.co.uk", role: "Owner", isPrimary: true },
      { name: "Workshop", email: "workshop@mobilepcdoctor.co.uk", role: "Repairs", isPrimary: false },
    ],
    domains: ["mobilepcdoctor.co.uk"],
  },
] as const;
```
Then add these idempotent helpers and call them from `main`'s per-client loop (each looks its row up before inserting, like every other seed step):
```ts
async function seedBillingProfile(db: Db, organisationId: string, clientId: string, billingName: string) {
  const [existing] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, clientId));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.billingProfiles)
    .values({ organisationId, clientId, billingName, paymentTermsDays: 14 })
    .returning();
  return created!;
}

async function seedContacts(
  db: Db,
  organisationId: string,
  clientId: string,
  contacts: readonly { name: string; email: string; role: string; isPrimary: boolean }[],
) {
  for (const contact of contacts) {
    const [existing] = await db
      .select()
      .from(schema.clientContacts)
      .where(and(eq(schema.clientContacts.clientId, clientId), eq(schema.clientContacts.name, contact.name)));
    if (existing) continue;
    await db.insert(schema.clientContacts).values({ organisationId, clientId, ...contact });
  }
}

async function seedDomains(db: Db, organisationId: string, clientId: string, siteId: string, names: readonly string[]) {
  for (const [index, name] of names.entries()) {
    const [existing] = await db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.organisationId, organisationId), eq(schema.domains.name, name)));
    if (existing) continue;
    await db.insert(schema.domains).values({
      organisationId,
      clientId,
      // The first domain points at the site; any extra is held without one.
      siteId: index === 0 ? siteId : null,
      name,
      registrar: "Namecheap",
      dnsProvider: index === 0 ? "cloudflare" : "registrar",
      nameservers: index === 0 ? ["ns1.cloudflare.test", "ns2.cloudflare.test"] : [],
    });
  }
}

async function seedActivity(db: Db, organisationId: string, clientId: string, clientName: string, siteId: string) {
  const [existing] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.clientId, clientId));
  if (existing) return;
  await db.insert(schema.activityEvents).values([
    { organisationId, clientId, actorKind: "system", kind: "client.created", title: `Client created: ${clientName}`, link: `/clients/${clientId}` },
    { organisationId, clientId, siteId, actorKind: "system", kind: "site.created", title: "Website added", link: `/websites/${siteId}` },
    { organisationId, clientId, actorKind: "system", kind: "domain.created", title: "Domain added", link: `/clients/${clientId}?tab=sites` },
  ]);
}

async function seedStaffMember(db: Db, organisationId: string) {
  const [existingUser] = await db.select().from(schema.user).where(eq(schema.user.email, STAFF.email));
  const user =
    existingUser ??
    (await db.insert(schema.user).values({ id: randomUUID(), name: STAFF.name, email: STAFF.email, emailVerified: true }).returning())[0]!;
  const [existingMember] = await db
    .select()
    .from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.userId, user.id)));
  if (existingMember) return existingMember;
  // No credential row: the staff account gets its one-time password when an
  // owner adds it from the Team screen. The seed never invents a password.
  const [created] = await db
    .insert(schema.organisationMembers)
    .values({ organisationId, userId: user.id, role: "staff", status: "invited", displayName: STAFF.name, title: STAFF.title })
    .returning();
  return created!;
}
```
Print the staff member and each client's domain count alongside the existing console lines.

Run: `pnpm db:seed && pnpm db:seed`
Expected: identical output twice, three domains in total, one of them with no site.

- [ ] **Step 7: Docs**

`docs/MODULE_MAP.md` — replace the admin table's rows so they match the shipped routes and the final navigation:
```md
| Route | Module | Plan | Reads | Writes |
|---|---|---|---|---|
| `/` | Dashboard | 1 | open incidents, pending approvals, open tickets | — |
| `/clients`, `/clients/[id]` | Clients | 2 | clients, contacts, billing profile, sites, domains, activity events | create/update/archive client, contacts, billing profile, sites, domains |
| `/websites`, `/websites/[id]` | Websites | 2 | sites, domains, dns records, monitors, incidents | create site (from the client page) |
| `/domains`, `/domains/[id]` | Domains | 2 | domains, dns records, sites | create/attach domain, dns record CRUD |
| `/tasks` | Tasks | 3 | — | — |
| `/inbox` | Inbox | 4 | — | — |
| `/tickets` | Open Cases | 1 (list), 4 (full) | tickets | — |
| `/incidents`, `/incidents/[id]` | Incidents | 1 | incidents, checks, agent run | acknowledge, resolve |
| `/payments`, `/invoices`, `/ads` | Money | 5 | — | — |
| `/approvals` | Approvals | 1 | pending approvals | approve/reject |
| `/settings/agents` | Agents | 1 | agent_enablement | toggle |
| `/knowledge` | Knowledge Base | 4 | — | — |
| `/team` | Team | 2 | organisation members + users | create member (one-time password), deactivate |
| `/settings/organisation` | Organisation | 2 | organisation, SUPPORT_EMAIL_DOMAIN | — |
| `/api/search` | Global search | 2 | clients, sites, domains, tickets | — |
```
Add a "Core services" section listing the Plan 2 folders (`activity`, `notifications`, `clients`, `billing`, `sites`, `domains`, `team`, `search`) with their exported functions.

`docs/DATA_MODEL.md` — confirm the Task 1 edits are present and add to the relationship summary: a client has many contacts, sites, domains and activity events, and exactly one billing profile; a domain belongs to a client and optionally to a site.

`README.md` — replace the Status section's "Working today" list with Plan 1 plus:
```md
- **Clients** — create a client with address and contacts; each gets a slug and a `slug@SUPPORT_EMAIL_DOMAIN` support address, an empty billing profile and a timeline. Search and status filters on the list; tabs for Overview, Contacts & Billing, Sites & Domains.
- **Websites and domains** — sites belong to clients; domains belong to clients and may exist before their site; DNS records recorded per domain (pushing them to a provider stays an approval-gated agent action).
- **Team** — the owner adds a member from `/team`; the account is created with a one-time password shown exactly once. Sign-up remains disabled.
- **Shell** — grouped left navigation (later plans shown disabled), header global search over clients, websites, domains and cases, and an in-app notifications bell.
```
and move Plan 2 out of "Not built yet", leaving Plans 3 to 5 with their spec summaries and pointing at `docs/superpowers/specs/2026-09-04-agency-os-full-build.md`. Add this plan to the Docs list.

- [ ] **Step 8: Full local verification**

Run, in order:
```bash
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @launchos/web build
pnpm --filter @launchos/web exec playwright test
```
Expected: every command green; all four Playwright specs (`admin-incidents`, `admin-shell`, `admin-clients`, `admin-team`) pass with `workers: 1`, so the client one spec creates is visible to the next.

Then check by hand with `pnpm dev` and `pnpm dev:worker`: create a client, watch the worker log `domain event with no consumer` for `client.created` (Plan 3 gives it one), and confirm the notification bell shows the "Team member added" entry after adding a member.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): team management with one-time passwords, organisation settings, richer seed and Plan 2 docs"
```

---

## Self-review

**Spec coverage**

| Spec item | Where |
|---|---|
| §1 P2 "clients CRUD with contacts, address, billing profile, notes" | Tasks 1, 4, 5, 10 |
| §1 P2 "sites and domains CRUD with DNS records" | Tasks 1, 6, 10, 11 |
| §1 P2 "team members (invite = admin-created account with one-time password)" | Tasks 7, 12 |
| §1 P2 "nav rebuilt; global search box" | Tasks 8, 9 |
| §2 ownership assertions — generic `assertOwned` | Task 2, used in Tasks 3, 5, 6 |
| §2 transactions, events after commit | Tasks 4, 5, 6 (`db.transaction` then `emit`) |
| §2 domain events extended; web enqueue not dropped | Tasks 2, 4 (`apps/web/src/lib/queue.ts`, `QUEUE.domainEvent`) |
| §2 notifications table + owner notification | Tasks 1, 3, 9 (bell), 7 (`notifyOwner` on member creation) |
| §2 financial details limited to `billing_profiles` | Tasks 1, 5, 10 (no card/bank fields anywhere) |
| §2 UI rules (shadcn, light, sidebar sheet <1024px, toasts, empty states, Zod both sides, footer) | Tasks 9, 10, 11, 12 |
| §2 search endpoint | Task 8 |
| §2 tests with real Postgres and random slugs/emails | every core task; `crypto.randomUUID()` in each fixture |
| §2 seed extended | Tasks 1 and 12 |
| §3 P2 `billing_profiles`, `clients` columns, `domains` columns, `organisation_members` columns, `client_users` FK, `notifications`, `activity_events` | Task 1 |
| §4 client creation (client, billing profile, `support_email` string, activity event, `client.created`) | Task 4; task generation explicitly left to Plan 3 |
| §5 navigation and client detail tabs | Tasks 9 (`NAV_GROUPS`), 10 (`ClientTabs`) |
| §6 `SUPPORT_EMAIL_DOMAIN`, `OWNER_NOTIFY_EMAIL` in `.env.example` | Task 4 |
| §7 P2 acceptance (client + contacts + billing + two domains + a site from the UI, appears in search, timeline shows events, team member added, sidebar shows the new nav) | Tasks 9, 10, 12 e2e specs |

**Placeholder scan**

No TODO, TBD, "similar to" or "add validation" anywhere: every file is given complete, or as a complete function with its exact insertion point. The only deferred items are named plans — `clients.package_id` FK (Plan 3), portal-users tab and the `email_identities` row for `support_email` (Plan 4), the `OWNER_NOTIFY_EMAIL` email leg (Plan 4, needs the email adapter), Tasks/Payments/Invoices/Ads/Knowledge nav entries (Plans 3–5), and `client.created` having no consumer until Plan 3.

**Type consistency**

- Every service is `(db: Db, organisationId: string, input)`; inputs are Zod objects typed with `z.input<>` wherever a default exists, matching `packages/core/src/monitoring/create-monitor.ts`.
- `assertOwned(db, organisationId, table, id)` derives its message from `getTableName(table)` minus a trailing `s`, so the Plan 1 strings `client … not found in organisation` and `site … not found in organisation` are unchanged and `assert-owned.test.ts` still passes.
- `escapeLike` is defined once in `packages/core/src/clients/list-clients.ts` (Task 4) and imported by `list-sites.ts`, `domains.ts` and `search.ts` (Tasks 6, 8).
- `ClientListRow`, `SiteListRow`, `DomainListRow`, `MemberRow`, `SearchResults` are the exact shapes the pages destructure in Tasks 10–12; `SearchResults` is imported by both `/api/search` and `global-search.tsx`.
- `ActionResult` is declared once in `apps/web/src/app/(admin)/clients/schemas.ts` and reused by the domains actions; `AddMemberState` is separate because the member action carries the one-time password.
- `DomainEvent` is a closed union; the worker narrows on `incident.opened` and logs the rest, so adding members breaks nothing.
- `createSite` gains defaulted fields only, so the Plan 1 agent tool call `createSite(db, org, { clientId, name, primaryUrl })` still type-checks.
- Migration numbering: the journal ends at `0002_natural_retro_girl`, so Task 1 writes `0003_client_system`.
