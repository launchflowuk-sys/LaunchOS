import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { projects } from "./projects.js";

/** A build we did for somebody, or one of the platforms we run ourselves. */
export const caseStudyKindEnum = pgEnum("case_study_kind", ["client", "product"]);
export type CaseStudyKind = (typeof caseStudyKindEnum.enumValues)[number];

/**
 * Where a story is in its life. `unlisted` is not `draft`: the page exists and
 * anyone holding the link can read it, it simply is not in the index — which
 * is what a client who is happy to be a reference but does not want to be an
 * advert gets.
 */
export const caseStudyStatusEnum = pgEnum("case_study_status", ["draft", "review", "published", "unlisted"]);
export type CaseStudyStatus = (typeof caseStudyStatusEnum.enumValues)[number];

/** The only status the public Work and Products pages read. */
export const CASE_STUDY_PUBLIC_STATUSES: readonly CaseStudyStatus[] = ["published"];

/**
 * What the thing itself is doing, as against what the *story about it* is
 * doing. Two separate facts that both used to be called `status`: a build can
 * be live while its case study is still a draft, and a case study can be
 * published for a site that is in testing.
 *
 * The labels keep the hyphens the marketing site already renders, so a value
 * survives the round trip into the database and back out without a lookup
 * table standing between the copy and the page.
 */
export const caseStudyDeliveryStatusEnum = pgEnum("case_study_delivery_status", [
  "live",
  "in-build",
  "in-testing",
  "discovery",
]);
export type CaseStudyDeliveryStatus = (typeof caseStudyDeliveryStatusEnum.enumValues)[number];

/** The brief, in the order an agency page reads it. */
export interface CaseStudyBrief {
  client: string;
  problem: string;
  built: string;
  results: string;
}

export const CASE_STUDY_BRIEF_DEFAULT: CaseStudyBrief = { client: "", problem: "", built: "", results: "" };

/**
 * What the capture script managed to photograph. Both are optional because a
 * site that was down when the worker visited gets no entry, and the page shows
 * a placeholder card rather than a broken image.
 */
export interface CaseStudyScreenshots {
  desktop?: string;
  mobile?: string;
}

/**
 * The platform badge: this build runs on something we also own.
 *
 * "We built the dispatch system underneath it too" is the part of a taxi
 * story an operator actually cares about, so it is a first-class field with
 * the platform's own mark rather than a sentence in the brief.
 */
export interface CaseStudyPoweredBy {
  name: string;
  /** Where the platform lives. */
  url: string;
  /** In `public/`, transparent, sized for a small badge. */
  logo: string;
  logoWidth: number;
  logoHeight: number;
}

/**
 * The portfolio, as data.
 *
 * It used to be a TypeScript array in the marketing app, which was the right
 * answer while Shoji was the only editor and a pull request was a better audit
 * trail than a table. It stopped being the right answer the moment a project
 * could write its own story: a delivered build now creates the row, the
 * milestones append to it, the worker attaches the screenshots and the Case
 * Study Writer drafts the copy — none of which can happen in a file that is
 * compiled into the bundle.
 *
 * The columns are therefore the union of what the two marketing arrays held,
 * not a tidier subset. Nothing that was written by hand was allowed to be
 * dropped on the way in: `client_name` is the short "who it was for" that sits
 * beside the longer `brief.client`, `delivery_status`, `charity` and
 * `powered_by` came off the client entries, and `domain`, `tagline`,
 * `description` and `facts` off the products. A column that only one `kind`
 * uses is a smaller price than a paragraph of Shoji's copy going missing.
 */
export const caseStudies = pgTable("case_studies", {
  ...tenantColumns(),
  /**
   * Nullable, unlike every other client-scoped table here, because the fifteen
   * stories seeded with this table are older than the client records — several
   * are Shoji's own businesses, which are not clients at all. A story that a
   * project created always has one.
   */
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  /** The public URL segment: `/work/<slug>`. Unique per organisation. */
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  /** Who it was for, short — "Chathwell Windows Ltd" under the name "LifeStyle Windows". */
  clientName: text("client_name"),
  sector: text("sector").default("").notNull(),
  /** One line for a card. */
  summary: text("summary").default("").notNull(),
  brief: jsonb("brief").$type<CaseStudyBrief>().default(CASE_STUDY_BRIEF_DEFAULT).notNull(),
  stack: text("stack").array().$type<string[]>().default([]).notNull(),
  /** The year it went live. Null for a platform we have never stopped building. */
  year: integer("year"),
  url: text("url"),
  screenshots: jsonb("screenshots").$type<CaseStudyScreenshots>().default({}).notNull(),
  /** On the home page. Four at most — the marketing pages take the first four. */
  featured: boolean("featured").default(false).notNull(),
  kind: caseStudyKindEnum("kind").default("client").notNull(),
  status: caseStudyStatusEnum("status").default("draft").notNull(),
  deliveryStatus: caseStudyDeliveryStatusEnum("delivery_status").default("live").notNull(),
  /** Built free, for the community. Said plainly on the card and the brief. */
  charity: boolean("charity").default(false).notNull(),
  poweredBy: jsonb("powered_by").$type<CaseStudyPoweredBy | null>(),
  /** Products only: the link text, where `url` is where it goes. */
  domain: text("domain"),
  /** Products only: one line under the name. */
  tagline: text("tagline"),
  /** Products only: a short paragraph — who it is for and what it does. */
  description: text("description"),
  /** Products only: two to four short facts. */
  facts: text("facts").array().$type<string[]>().default([]).notNull(),
  /** The order Shoji dragged them into. Ties break on `created_at`. */
  sort: integer("sort").default(0).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("case_studies_org_slug").on(t.organisationId, t.slug),
  // One story per project. The seeded rows have no project and NULLs are
  // distinct in Postgres, so they are unaffected; what this stops is the
  // delivery job creating a second case study when pg-boss retries it.
  uniqueIndex("case_studies_project").on(t.projectId),
  index("case_studies_org_status_sort").on(t.organisationId, t.status, t.sort),
  index("case_studies_org_client").on(t.organisationId, t.clientId),
]);
