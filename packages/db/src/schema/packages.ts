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
