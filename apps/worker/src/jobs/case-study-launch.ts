import { CASE_STUDY_WRITER_KEY } from "@launchos/agents";
import {
  createContentAsset,
  getCaseStudyForProject,
  publicAssetUrl,
  requireProject,
  updateCaseStudy,
  type CaseStudyRow,
} from "@launchos/core";
import { SCREENSHOT_VIEWPORT_KEYS, ScreenshotFailed, captureScreenshot, type ScreenshotViewport } from "@launchos/channels/pdf";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { isBlockedTarget } from "@launchos/integrations";
import { and, eq, sql } from "drizzle-orm";
import { QUEUE } from "../boss.js";
import type { AgentRunJob } from "./agent-run.js";
import type { BossSender } from "./dispatch-event.js";

/**
 * What happens the moment a build is signed off: the pictures, then the story.
 *
 * Both belong here rather than in `deliverProject`, and for the two reasons
 * every other "after the transaction" job in LaunchOS exists. Photographing a
 * live site takes twenty seconds and reaches somebody else's server, which
 * must not sit inside the transaction that records the delivery; and starting
 * the Case Study Writer is an Opus-priced run that must not be able to fail
 * the click that signed the work off.
 *
 * **One browser.** The screenshots are taken with the headless Chromium the
 * PDF engine already runs — `captureScreenshot` borrows the same process-wide
 * renderer `renderProposalDocument` prints through, and `installPdfShutdown`
 * in `apps/worker/src/pdf.ts` is what closes it on SIGTERM. There is no
 * Puppeteer here and no second Playwright instance: two Chromiums in one
 * container is 240 MB of resident memory and a second thing to remember to
 * close, for a picture.
 */

/** `case_studies.metadata` — set once the launch shots have been taken. */
export const SCREENSHOTS_TAKEN_AT = "screenshotsTakenAt";
/** `case_studies.metadata` — set once the writer has been started, so a retry does not run it twice. */
export const WRITER_STARTED_AT = "writerStartedAt";

export interface ProjectDeliveredJob {
  organisationId: string;
  projectId: string;
}

export interface ProjectDeliveredDeps {
  readonly db: Db;
  readonly boss: BossSender;
  readonly env: NodeJS.ProcessEnv;
  readonly logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface ProjectDeliveredResult {
  projectId: string;
  caseStudyId: string | null;
  /** The viewports actually captured this run. Empty when there was no URL, or they were already taken. */
  captured: ScreenshotViewport[];
  /** Why nothing was captured, when nothing was. */
  screenshotsSkipped: "no_case_study" | "no_url" | "blocked_url" | "already" | null;
  writerStarted: boolean;
}

/**
 * Takes the launch screenshots and starts the Case Study Writer.
 *
 * Every step is stamped on the case study's own `metadata`, so the job is safe
 * to run twice — and it will be, because pg-boss retries and because the
 * `project.delivered` event can be re-emitted by a replayed domain event.
 *
 * A screenshot failure is logged and does not stop the writer. The pictures
 * are the nicest part of a case study and not the necessary part; a story with
 * no photograph is a story Shoji can add a photograph to, while a story nobody
 * wrote is a portfolio that is three builds out of date.
 */
export async function handleProjectDelivered(
  deps: ProjectDeliveredDeps,
  job: ProjectDeliveredJob,
): Promise<ProjectDeliveredResult> {
  const logger = deps.logger ?? console;
  const project = await requireProject(deps.db, job.organisationId, job.projectId);
  const study = await getCaseStudyForProject(deps.db, job.organisationId, project.id);
  if (!study) {
    logger.info({ ...job }, "project delivered with no case study attached; nothing to write");
    return { projectId: project.id, caseStudyId: null, captured: [], screenshotsSkipped: "no_case_study", writerStarted: false };
  }

  const shots = await captureLaunchScreenshots(deps, job.organisationId, study, logger);
  const writerStarted = await startWriter(deps, job.organisationId, study.id, logger);
  return {
    projectId: project.id,
    caseStudyId: study.id,
    captured: shots.captured,
    screenshotsSkipped: shots.skipped,
    writerStarted,
  };
}

interface CaptureOutcome {
  captured: ScreenshotViewport[];
  skipped: ProjectDeliveredResult["screenshotsSkipped"];
}

/**
 * Photographs the live site at both sizes and files the pictures as content
 * assets.
 *
 * The URL comes off `case_studies.url`, which the Case Study Writer's
 * `case_study_save_draft` can set — so it is vetted here with the same
 * `isBlockedTarget` the uptime probe uses before it is handed to a browser
 * running without Chromium's own sandbox. http(s) only, no loopback, no
 * RFC 1918, no link-local. Without that check a model that wrote
 * `http://169.254.169.254/latest/meta-data/` into a case study would have the
 * worker screenshot the cloud metadata service and publish it.
 *
 * The files go through `createContentAsset`, which is where every other image
 * in LaunchOS lives: `STORAGE_DIR/content/<org>/<uuid>.png`, served by
 * `/api/assets/<id>`. Nothing new had to be built for storage, and the
 * marketing page renders the URL exactly as it renders the twenty seeded
 * `/work/<slug>-desktop.jpg` paths.
 */
async function captureLaunchScreenshots(
  deps: ProjectDeliveredDeps,
  organisationId: string,
  study: CaseStudyRow,
  logger: Pick<Console, "info" | "warn" | "error">,
): Promise<CaptureOutcome> {
  if (study.metadata[SCREENSHOTS_TAKEN_AT]) return { captured: [], skipped: "already" };
  const url = study.url?.trim();
  if (!url) {
    logger.info({ caseStudyId: study.id }, "no public url on the case study; no launch screenshots taken");
    return { captured: [], skipped: "no_url" };
  }
  if (isBlockedTarget(url)) {
    logger.warn({ caseStudyId: study.id, url }, "refusing to screenshot a private or non-http address");
    return { captured: [], skipped: "blocked_url" };
  }
  if (!study.clientId) {
    // A content asset belongs to a client; a story with none (the seeded
    // portfolio rows) has nowhere to file a picture.
    logger.info({ caseStudyId: study.id }, "case study has no client; launch screenshots skipped");
    return { captured: [], skipped: "no_case_study" };
  }

  const screenshots: Record<string, string> = { ...study.screenshots };
  const captured: ScreenshotViewport[] = [];
  for (const viewport of SCREENSHOT_VIEWPORT_KEYS) {
    try {
      const shot = await captureScreenshot({ url, viewport }, deps.env);
      const asset = await createContentAsset(deps.db, organisationId, {
        clientId: study.clientId,
        bytes: shot.bytes,
        mime: shot.mime,
        originalName: `${study.slug}-${viewport}.png`,
        alt: `${study.name} on ${viewport === "mobile" ? "a phone" : "a laptop"}`,
        source: "generated",
        actorKind: "system",
      }, deps.env);
      screenshots[viewport] = publicAssetUrl(asset.id, deps.env);
      captured.push(viewport);
    } catch (error) {
      // One size failing must not cost the other. A site that will not load at
      // all fails both, logs both, and the story is written without pictures.
      const message = error instanceof ScreenshotFailed ? error.message : String(error);
      logger.error({ caseStudyId: study.id, url, viewport, err: message }, "launch screenshot failed");
    }
  }
  if (captured.length === 0) return { captured, skipped: null };

  await updateCaseStudy(deps.db, organisationId, {
    caseStudyId: study.id,
    screenshots,
    actorKind: "system",
  });
  // Stamped after the pictures are on the row, never before: a stamp taken
  // first would mean a crash mid-capture left a story that can never get its
  // photographs.
  await stamp(deps.db, organisationId, study.id, SCREENSHOTS_TAKEN_AT);
  return { captured, skipped: null };
}

/**
 * Starts the writer, once.
 *
 * The stamp is claimed conditionally before the send, so two deliveries racing
 * — or a retried job — produce one run. The `agent.run` key is a second belt
 * while the job is still queued; the stamp is what holds once it is running.
 */
async function startWriter(
  deps: ProjectDeliveredDeps,
  organisationId: string,
  caseStudyId: string,
  logger: Pick<Console, "info" | "warn" | "error">,
): Promise<boolean> {
  const claimed = await stamp(deps.db, organisationId, caseStudyId, WRITER_STARTED_AT, { onlyIfUnset: true });
  if (!claimed) {
    logger.info({ caseStudyId }, "case study writer already started for this story");
    return false;
  }
  const run: AgentRunJob = {
    agentKey: CASE_STUDY_WRITER_KEY,
    organisationId,
    trigger: "event",
    payload: { caseStudyId },
  };
  await deps.boss.send(QUEUE.agentRun, run, { singletonKey: `case-study-writer:${caseStudyId}` });
  return true;
}

/** One conditional jsonb merge on `case_studies.metadata`. Returns false when the key was already set. */
async function stamp(
  db: Db,
  organisationId: string,
  caseStudyId: string,
  key: string,
  options: { onlyIfUnset?: boolean } = {},
): Promise<boolean> {
  const rows = await db
    .update(schema.caseStudies)
    .set({
      metadata: sql`coalesce(${schema.caseStudies.metadata}, '{}'::jsonb) || ${JSON.stringify({ [key]: new Date().toISOString() })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.caseStudies.id, caseStudyId),
      eq(schema.caseStudies.organisationId, organisationId),
      options.onlyIfUnset ? sql`(${schema.caseStudies.metadata}->>${key}) IS NULL` : undefined,
    ))
    .returning({ id: schema.caseStudies.id });
  return rows.length > 0;
}
