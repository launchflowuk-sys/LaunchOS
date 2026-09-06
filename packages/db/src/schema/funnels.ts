import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { leads } from "./leads.js";

/**
 * The Funnel Engine, folded in.
 *
 * It used to be a product of its own: one config file per client, deployed
 * separately, with its own little server. That was a deploy every time a
 * question changed, which is why it never got past two clients. Here a funnel
 * is a row and its questions are a jsonb array, so a new one is a form on
 * `/funnels` and a link to hand to an ad.
 *
 * The shape of the thing is the point, and it is not a contact form with
 * extra steps: **the contact step sits in the middle**. Five or six screens,
 * one question each, and the name and number are asked at screen three — so a
 * visitor who gets bored at screen four has still told us who they are. That
 * one decision is why partial completions are worth having, and why
 * `funnel_sessions.lead_id` is filled long before `completed_at` is.
 */

export const funnelStatusEnum = pgEnum("funnel_status", ["draft", "published", "archived"]);
export type FunnelStatus = (typeof funnelStatusEnum.enumValues)[number];

/** How far a visitor got. `contacted` is the one that pays for the funnel. */
export const funnelSessionStatusEnum = pgEnum("funnel_session_status", ["started", "contacted", "completed"]);
export type FunnelSessionStatus = (typeof funnelSessionStatusEnum.enumValues)[number];

/**
 * `choice` is a list of buttons, one tap, and the only kind that scores.
 * `text` is a free sentence — never scored, because a scoring rule over free
 * text is a guess dressed as a number. `contact` is the name/phone/email
 * screen, and there is exactly one of them in a funnel.
 */
export type FunnelStepKind = "choice" | "text" | "contact";

export interface FunnelChoiceOption {
  /** Stored on the answer; stable when the label is reworded. */
  value: string;
  label: string;
  /** Added to the session's score when chosen. Negative is allowed — "just browsing" should cost. */
  points: number;
}

export interface FunnelStep {
  /** Stable key the answers are filed under. Lower-case, hyphenated. */
  key: string;
  kind: FunnelStepKind;
  question: string;
  /** One line under the question. */
  help?: string | undefined;
  required: boolean;
  /** `choice` only. */
  options?: FunnelChoiceOption[] | undefined;
  /** `text` only. */
  placeholder?: string | undefined;
  /** `contact` only: what the middle screen asks for beyond a name and a number. */
  contact?: { askEmail: boolean; askBusiness: boolean; emailRequired: boolean } | undefined;
}

/** The screen after the last question. */
export interface FunnelSuccess {
  headline: string;
  body: string;
  /** Optional button — usually the booking page. */
  ctaLabel?: string | undefined;
  ctaUrl?: string | undefined;
}

export const FUNNEL_SUCCESS_DEFAULT: FunnelSuccess = {
  headline: "Thank you — that is everything we need",
  body: "We read every enquiry ourselves. Expect a reply within one working day.",
};

export const funnels = pgTable("funnels", {
  ...tenantColumns(),
  /**
   * Nullable: LaunchFlow runs funnels for its own ads as well as for clients,
   * and a funnel with no client is ours. A client's funnel follows them
   * through a merge (`MOVE_SPECS`).
   */
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  /** The public URL segment: `/f/<slug>`. Unique per organisation. */
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  headline: text("headline").default("").notNull(),
  subheadline: text("subheadline").default("").notNull(),
  status: funnelStatusEnum("status").default("draft").notNull(),
  steps: jsonb("steps").$type<FunnelStep[]>().default([]).notNull(),
  success: jsonb("success").$type<FunnelSuccess>().default(FUNNEL_SUCCESS_DEFAULT).notNull(),
  /**
   * The score at or above which the owner is buzzed the moment the contact
   * step is answered. Zero switches the alert off rather than making every
   * lead hot — a threshold of nothing is not a threshold.
   */
  hotScore: integer("hot_score").default(0).notNull(),
  /** What `createLead` records as the lead's `source`. Always `funnel` today; a column so a campaign can label its own. */
  leadSource: text("lead_source").default("funnel").notNull(),
}, (t) => [
  uniqueIndex("funnels_org_slug").on(t.organisationId, t.slug),
  index("funnels_org_status").on(t.organisationId, t.status),
]);

/**
 * One visitor's walk through a funnel.
 *
 * Written on the first answer and updated on every one after, so an abandoned
 * walk is a row with a `lead_id` and no `completed_at` rather than nothing at
 * all. `token` is the visitor's only claim on the row — it never leaves their
 * browser tab and is not guessable — so an answer posted later in the walk
 * cannot touch anybody else's session.
 */
export const funnelSessions = pgTable("funnel_sessions", {
  ...tenantColumns(),
  funnelId: uuid("funnel_id").notNull().references(() => funnels.id, { onDelete: "cascade" }),
  /** Set the moment the contact step is answered, not on completion. */
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  token: text("token").notNull(),
  status: funnelSessionStatusEnum("status").default("started").notNull(),
  /** `{ [stepKey]: { value, label, points } }` — what they tapped, in their words. */
  answers: jsonb("answers").$type<Record<string, FunnelAnswer>>().default({}).notNull(),
  score: integer("score").default(0).notNull(),
  /** How many steps have an answer; what "they got to screen four" means. */
  answered: integer("answered").default(0).notNull(),
  contactedAt: timestamp("contacted_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("funnel_sessions_token").on(t.token),
  index("funnel_sessions_org_funnel_created").on(t.organisationId, t.funnelId, t.createdAt),
]);

/** One answer as it is stored: the machine value, the words the visitor saw, and what it scored. */
export interface FunnelAnswer {
  value: string;
  label: string;
  points: number;
}
