import { OPS_BRIEF_CRON, OPS_BRIEF_KEY } from "@launchos/agents";
import { renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import { brandEmailContext, notifyOwner } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { OpsBriefHighlight } from "@launchos/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { QUEUE } from "../boss.js";
import { handleAgentRun, type AgentRunDeps } from "./agent-run.js";
import { LONDON, type BossRegistrar } from "./content-jobs.js";
import { sweepOrganisations } from "./sweep-organisations.js";

export { OPS_BRIEF_CRON };

/** The bell's `kind`, and where the bell and the email both send the owner. */
export const OPS_BRIEF_NOTIFICATION_KIND = "ops_brief.ready";
export const OPS_BRIEF_LINK = "/briefs";

/** Stamped on `ops_briefs.metadata` once the owner has been told, so a retried job tells them once. */
export const OPS_BRIEF_NOTIFIED_AT = "notifiedAt";

export interface OpsBriefJob {
  /** One organisation (a manual "write today's brief"); absent from the cron, which sweeps them all. */
  organisationId?: string;
  trigger?: "cron" | "manual";
}

export interface OpsBriefLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface OpsBriefDeps {
  readonly db: Db;
  readonly agentRun: AgentRunDeps;
  readonly email: EmailAdapter;
  /** `OWNER_NOTIFY_EMAIL`, `MAIL_FROM` and `APP_URL` are read from here; nothing else. */
  readonly env: NodeJS.ProcessEnv;
  readonly logger?: OpsBriefLogger;
}

export interface OpsBriefResult {
  organisationId: string;
  /** `skipped` when the agent is disabled; `no_brief` when the run ended without saving one. */
  outcome: "skipped" | "failed" | "no_brief" | "already_notified" | "notified";
  runId?: string;
  briefId?: string;
  emailedTo?: string;
}

/**
 * Switches the Ops Brief on, once, for every organisation that has never
 * decided about it — the same insert-only default the Content Writer gets at
 * boot. A row that exists, on or off, is never touched: Settings → Agents
 * stays the authority. The brief writes nothing a client sees, so "on unless
 * switched off" is the right default.
 */
export async function ensureOpsBriefEnabled(db: Db, logger: Pick<OpsBriefLogger, "info"> = console): Promise<{ enabled: number }> {
  const organisations = await db.select({ id: schema.organisations.id }).from(schema.organisations);
  if (organisations.length === 0) return { enabled: 0 };
  const inserted = await db
    .insert(schema.agentEnablement)
    .values(organisations.map((org) => ({ organisationId: org.id, agentKey: OPS_BRIEF_KEY, enabled: true })))
    .onConflictDoNothing({ target: [schema.agentEnablement.organisationId, schema.agentEnablement.agentKey] })
    .returning({ organisationId: schema.agentEnablement.organisationId });
  if (inserted.length > 0) {
    logger.info({ agent: OPS_BRIEF_KEY, organisations: inserted.map((r) => r.organisationId) }, "ops brief enabled by default");
  }
  return { enabled: inserted.length };
}

/** `Wednesday 9 September 2026`, from a `YYYY-MM-DD` brief date. */
export function briefDateLabel(briefDate: string): string {
  return new Date(`${briefDate}T12:00:00Z`)
    .toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: LONDON })
    .replace(",", "");
}

/**
 * The brief's Markdown as the paragraphs `renderBrandedEmail` escapes: a
 * heading becomes its own line, a bullet keeps a bullet, a Markdown link
 * becomes "label (absolute url)" so the admin paths the agent writes are
 * clickable from a mail client, and bold markers go. Nothing here is trusted
 * HTML; the template escapes every line.
 */
export function briefToParagraphs(bodyMd: string, appUrl: string): string[] {
  const link = (_: string, label: string, target: string) =>
    `${label} (${target.startsWith("/") ? `${appUrl}${target}` : target})`;
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join("\n"));
    current = [];
  };
  for (const raw of bodyMd.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) { flush(); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { flush(); paragraphs.push(heading[1]!.trim()); continue; }
    const cleaned = line
      .replace(/^[-*]\s+/, "• ")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, link)
      .replace(/\*\*([^*]+)\*\*/g, "$1");
    current.push(cleaned);
  }
  flush();
  return paragraphs;
}

type Brief = typeof schema.opsBriefs.$inferSelect;

async function briefForRun(db: Db, organisationId: string, runId: string): Promise<Brief | undefined> {
  const [row] = await db
    .select()
    .from(schema.opsBriefs)
    .where(and(eq(schema.opsBriefs.organisationId, organisationId), eq(schema.opsBriefs.agentRunId, runId)))
    .limit(1);
  return row;
}

function bellBody(brief: Brief): string {
  const highlights = brief.highlights as OpsBriefHighlight[];
  if (highlights.length === 0) return "Nothing needs you today.";
  const labels = highlights.slice(0, 3).map((h) => h.label);
  const more = highlights.length > 3 ? ` and ${highlights.length - 3} more` : "";
  return `Needs you: ${labels.join("; ")}${more}.`;
}

/** Best effort: a mail failure is logged, never thrown, because the bell has already rung and a retry would ring it twice. */
async function emailOwner(deps: OpsBriefDeps, brief: Brief, logger: OpsBriefLogger): Promise<string | undefined> {
  const to = deps.env.OWNER_NOTIFY_EMAIL?.trim();
  if (!to) return undefined;
  const brand = brandEmailContext(deps.env);
  const heading = `Ops Brief — ${briefDateLabel(brief.briefDate)}`;
  const { text, html } = renderBrandedEmail({
    variant: "internal",
    preheader: bellBody(brief),
    heading,
    paragraphs: briefToParagraphs(brief.bodyMd, brand.appUrl),
    cta: { label: "Open in LaunchOS", url: `${brand.appUrl}${OPS_BRIEF_LINK}` },
    footerNote: "Written by the Ops Brief agent from LaunchOS's own records; every figure is in the portal.",
    logoUrl: brand.logoUrl,
    appUrl: brand.appUrl,
    supportEmail: brand.supportEmail,
  });
  try {
    await deps.email.send({ to, from: deps.env.MAIL_FROM?.trim() || to, subject: heading, text, html });
    return to;
  } catch (error) {
    logger.error({ organisationId: brief.organisationId, briefId: brief.id }, "ops brief email failed", error);
    return undefined;
  }
}

/**
 * Runs the Ops Brief agent for one organisation and, once it has saved the
 * day's brief, tells the owner: the bell always, the branded email when
 * `OWNER_NOTIFY_EMAIL` is set. The brief row is the record: a run that
 * finishes without one is logged and nobody is told, and a brief already
 * stamped `notifiedAt` is not announced again — `createOpsBrief` clears the
 * stamp when a re-run replaces the body, which is the one case a second
 * announcement is right.
 */
export async function runOpsBriefFor(deps: OpsBriefDeps, organisationId: string, options: { now: Date; trigger?: "cron" | "manual" }): Promise<OpsBriefResult> {
  const logger = deps.logger ?? console;
  const trigger = options.trigger ?? "cron";
  const result = await handleAgentRun(deps.agentRun, {
    agentKey: OPS_BRIEF_KEY, organisationId, trigger, payload: { now: options.now.toISOString() },
  });
  if (!result) return { organisationId, outcome: "skipped" };
  if (result.status !== "completed") {
    logger.warn({ organisationId, runId: result.runId, status: result.status }, "ops brief run did not complete");
    return { organisationId, outcome: "failed", runId: result.runId };
  }

  const brief = await briefForRun(deps.db, organisationId, result.runId);
  if (!brief) {
    logger.warn({ organisationId, runId: result.runId }, "ops brief run completed without saving a brief");
    return { organisationId, outcome: "no_brief", runId: result.runId };
  }
  if (brief.metadata[OPS_BRIEF_NOTIFIED_AT]) {
    return { organisationId, outcome: "already_notified", runId: result.runId, briefId: brief.id };
  }

  await notifyOwner(deps.db, organisationId, {
    kind: OPS_BRIEF_NOTIFICATION_KIND,
    title: `Ops Brief for ${briefDateLabel(brief.briefDate)}`,
    body: bellBody(brief),
    link: OPS_BRIEF_LINK,
  });
  const emailedTo = await emailOwner(deps, brief, logger);

  const stamp = { [OPS_BRIEF_NOTIFIED_AT]: options.now.toISOString(), ...(emailedTo ? { emailedTo } : {}) };
  await deps.db
    .update(schema.opsBriefs)
    .set({ metadata: sql`coalesce(${schema.opsBriefs.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`, updatedAt: options.now })
    .where(and(eq(schema.opsBriefs.id, brief.id), eq(schema.opsBriefs.organisationId, organisationId)));

  logger.info({ organisationId, runId: result.runId, briefId: brief.id, emailedTo }, "ops brief ready");
  return { organisationId, outcome: "notified", runId: result.runId, briefId: brief.id, ...(emailedTo ? { emailedTo } : {}) };
}

export interface OpsBriefJobDeps extends OpsBriefDeps {
  readonly boss: BossRegistrar;
}

/**
 * Registers the `ops.brief` worker and its 07:00 Europe/London cron. A cron
 * tick (payload `{}`) sweeps every organisation with the usual per-org
 * isolation; a payload naming one organisation runs just that one, which is
 * what the web's "write today's brief" sends.
 */
export async function registerOpsBriefJob(deps: OpsBriefJobDeps): Promise<void> {
  const logger = deps.logger ?? console;
  await deps.boss.work<OpsBriefJob>(QUEUE.opsBrief, async ([job]) => {
    const data = job?.data ?? {};
    const now = new Date();
    if (data.organisationId) {
      const result = await runOpsBriefFor(deps, data.organisationId, { now, trigger: data.trigger ?? "manual" });
      logger.info(result, "ops brief");
      return;
    }
    await sweepOrganisations(
      deps.db,
      "ops brief",
      async (organisationId) => {
        const result = await runOpsBriefFor(deps, organisationId, { now, trigger: "cron" });
        logger.info(result, "ops brief");
      },
      logger,
    );
  });
  await deps.boss.schedule(QUEUE.opsBrief, OPS_BRIEF_CRON, {}, { tz: LONDON });
}
