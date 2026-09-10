import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { leads } from "./leads.js";

/**
 * One attempt at turning an enquiry into a website somebody can look at.
 *
 * The chain has several stages, each of which can take minutes and fail on its
 * own — generate, create the hosting, install WordPress, upload, review. A job
 * that held all that in memory would lose it on a restart and leave a half-made
 * site on the host with nothing pointing at it. This row is what makes the
 * process resumable and what makes an orphan findable.
 */

/**
 * Where a build has got to.
 *
 * `review` is the important one: the site exists and works, and **nobody
 * outside has been told**. Everything before it is machinery; everything after
 * it is a person's decision. A generated site reaching a client unreviewed
 * cannot be walked back — they have seen it, and so has Google.
 */
export const siteBuildStageEnum = pgEnum("site_build_stage", [
  /** Accepted, nothing done yet. */
  "queued",
  /** Asking the model for pages. */
  "generating",
  /** Creating the website and installing WordPress. */
  "provisioning",
  /** Putting the generated pages onto the host. */
  "uploading",
  /** Built, working, and waiting for a person. Nothing has left the building. */
  "review",
  /** Shoji said yes. The client may now be told. */
  "approved",
  /** The client has been told. */
  "notified",
  /** Stopped. `error` says why, at whichever stage it stopped. */
  "failed",
  /** Abandoned by a person. Kept so the hosting can still be torn down. */
  "cancelled",
]);
export type SiteBuildStage = (typeof siteBuildStageEnum.enumValues)[number];

export const siteBuilds = pgTable(
  "site_builds",
  {
    ...tenantColumns(),
    /** The enquiry it came from. Kept even after conversion, as the origin. */
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    /** Set once the lead becomes a client, so the build follows them. */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /**
     * Where the review copy lives — a domain of ours, never the client's own.
     * Nothing touches their real domain until after approval.
     */
    domain: text("domain").notNull(),
    stage: siteBuildStageEnum("stage").default("queued").notNull(),
    /** The hosting account the site landed on. Needed for every WordPress call. */
    hostingUsername: text("hosting_username"),
    /** Absolute path on the host, for the upload step. */
    rootDirectory: text("root_directory"),
    websiteUrl: text("website_url"),
    adminUrl: text("admin_url"),
    /** Which model wrote it, so a bad batch can be traced to its source. */
    generatorModel: text("generator_model"),
    /** The generated pages and stylesheet, kept so a re-upload needs no re-generation. */
    generated: jsonb("generated").$type<Record<string, unknown>>(),
    /**
     * Why it stopped, in the provider's own words where there are any. A route
     * mismatch and a real failure read differently and must stay that way.
     */
    error: text("error"),
    /** The approval card a person decides. Null until it reaches review. */
    approvalId: uuid("approval_id"),
    reviewReadyAt: timestamp("review_ready_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * One live build per domain. A retry resumes the row it already has rather
     * than starting a second against the same hosting — which is how two jobs
     * end up installing WordPress over each other.
     */
    uniqueIndex("site_builds_org_domain").on(t.organisationId, t.domain),
    index("site_builds_org_stage").on(t.organisationId, t.stage),
  ],
);
