import { boolean, date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { proposals } from "./proposals.js";

export const projectStatusEnum = pgEnum("project_status", [
  "planned",
  "active",
  "on_hold",
  "delivered",
  "cancelled",
]);
export type ProjectStatus = (typeof projectStatusEnum.enumValues)[number];

/** The statuses where the work is still in front of us, not behind. */
export const PROJECT_OPEN_STATUSES: readonly ProjectStatus[] = ["planned", "active", "on_hold"];
/** Nothing moves after these: the build is either handed over or abandoned. */
export const PROJECT_CLOSED_STATUSES: readonly ProjectStatus[] = ["delivered", "cancelled"];

/**
 * The six steps every LaunchFlow build goes through, in the order they happen.
 *
 * A closed set rather than free text because the client's progress page draws
 * them as a spine and the same six words have to mean the same six things on
 * every project — "design" on one build and "Design & UX" on the next would
 * make two projects impossible to compare and the spine impossible to draw.
 * `care` is after launch on purpose: the retainer is part of the job, not an
 * afterthought, and a client on a monthly plan should see it on the page.
 */
export const projectPhaseKeyEnum = pgEnum("project_phase_key", [
  "brief",
  "design",
  "build",
  "review",
  "launch",
  "care",
]);
export type ProjectPhaseKey = (typeof projectPhaseKeyEnum.enumValues)[number];
export const PROJECT_PHASE_KEYS = projectPhaseKeyEnum.enumValues;

/**
 * Where a phase stands.
 *
 * `skipped` is the one that earns its place: a client who supplied their own
 * design does not have a design phase, and marking it `done` would be a lie
 * while leaving it `pending` would hold their progress bar down for ever.
 * `projectProgress` counts a skipped phase in neither the numerator nor the
 * denominator, which is the only honest answer.
 */
export const projectPhaseStatusEnum = pgEnum("project_phase_status", [
  "pending",
  "active",
  "done",
  "skipped",
]);
export type ProjectPhaseStatus = (typeof projectPhaseStatusEnum.enumValues)[number];

/**
 * The container for a build: "the website for KD Landscapes", from the
 * accepted proposal to the day it goes live.
 *
 * Before this existed there were tasks with an onboarding phase and nothing
 * above them, so a client could see twelve ticks and still not know how far
 * through they were. A project is the one place both sides look: Shoji sees
 * every build on one list, the client sees one honest number.
 *
 * `proposal_id` is nullable and unique. Nullable because Shoji starts work for
 * an existing client without writing a proposal often enough that requiring
 * one would mean fake proposals; unique because an accepted proposal creates
 * exactly one project and the worker job that does it will be retried — the
 * index, not the job's stamp, is what makes a second run a no-op.
 */
export const projects = pgTable("projects", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  proposalId: uuid("proposal_id").references(() => proposals.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  summary: text("summary"),
  status: projectStatusEnum("status").default("planned").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  /**
   * The date we told the client, in Europe/London. A date rather than an
   * instant for the same reason a proposal's validity is: "the end of March"
   * is what was promised, and an hour either side of midnight is not news.
   */
  targetDate: date("target_date", { mode: "string" }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("projects_proposal").on(t.proposalId),
  index("projects_org_status_created").on(t.organisationId, t.status, t.createdAt),
  index("projects_org_client").on(t.organisationId, t.clientId),
]);

/**
 * One step of the spine, per project.
 *
 * `key` is unique per project, so a project cannot grow two build phases and
 * the six standard steps can be topped up idempotently. `name` is separate
 * from `key` so the label can read "Design and content" on one project and
 * "Design" on another without the two ceasing to be the same step.
 *
 * `client_id` is denormalised from the project on purpose: every table that
 * carries one joins `MOVE_SPECS` in `packages/core/src/clients/merge-clients.ts`,
 * and a merge that moved the project but left its phases pointing at an
 * archived client would break the progress page rather than the merge — which
 * is far harder to notice.
 */
export const projectPhases = pgTable("project_phases", {
  ...tenantColumns(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  key: projectPhaseKeyEnum("key").notNull(),
  name: text("name").notNull(),
  sort: integer("sort").default(0).notNull(),
  status: projectPhaseStatusEnum("status").default("pending").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  doneAt: timestamp("done_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("project_phases_project_key").on(t.projectId, t.key),
  index("project_phases_project_sort").on(t.projectId, t.sort),
  index("project_phases_org_client").on(t.organisationId, t.clientId),
]);

/**
 * A promise with a date on it: "the booking engine takes a live payment".
 *
 * Milestones are what the client recognises — a phase is our vocabulary, a
 * milestone is theirs — which is why `projectProgress` counts them alongside
 * phases rather than as decoration, and why `client_visible` exists: an
 * internal checkpoint ("Stripe keys rotated") belongs on the project without
 * appearing on the client's page.
 *
 * `reached_at` is the whole state. There is no `status` column because there
 * are only two answers, and a nullable timestamp records both of them plus
 * the day it happened, which the Friday update needs anyway.
 */
export const projectMilestones = pgTable("project_milestones", {
  ...tenantColumns(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  phaseId: uuid("phase_id").references(() => projectPhases.id, { onDelete: "set null" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  detail: text("detail"),
  targetDate: date("target_date", { mode: "string" }),
  reachedAt: timestamp("reached_at", { withTimezone: true }),
  sort: integer("sort").default(0).notNull(),
  clientVisible: boolean("client_visible").default(true).notNull(),
}, (t) => [
  index("project_milestones_project_sort").on(t.projectId, t.sort),
  index("project_milestones_org_client").on(t.organisationId, t.clientId),
  index("project_milestones_project_reached").on(t.projectId, t.reachedAt),
]);
