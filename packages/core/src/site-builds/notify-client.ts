import { renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandEmailContext, supportEmailFor } from "../config.js";
import { notifyOwner } from "../notifications/notify.js";
import type { SiteBuildRow } from "./site-builds.js";

/**
 * The last stage, and the only one that cannot be walked back.
 *
 * Everything before this happens inside the building: a site is generated,
 * hosted, uploaded and looked at, and the person it was built for knows none of
 * it. This function is the moment they find out. There is no undo — they have
 * seen it — so it is a separate deliberate act from approving, with its own
 * button, its own timestamp and its own actor, rather than something a build
 * drifts into two minutes after somebody clicks Approve.
 *
 * The worker never calls this. `runSiteBuilds` skips `approved` rows on
 * purpose; a cron job that emails clients is exactly the thing rule 2 exists
 * to prevent.
 */

export const NotifySiteBuildInput = z.object({
  buildId: z.string().uuid(),
  actorId: z.string().min(1),
  /**
   * A line from Shoji above the standard body. Escaped by the template like
   * everything else — it is typed text, not markup.
   */
  note: z.string().trim().max(2000).optional(),
});
export type NotifySiteBuildInput = z.input<typeof NotifySiteBuildInput>;

export interface SiteBuildRecipient {
  name: string;
  email: string;
  clientId: string | null;
}

export type NotifySiteBuildResult =
  | { sent: true; build: SiteBuildRow; recipient: SiteBuildRecipient }
  | { sent: false; alreadyNotified: true; build: SiteBuildRow };

/**
 * Tells the client their site is ready to look at.
 *
 * The claim commits before the mail server is touched, so two presses cannot
 * become two emails. If the send then fails the row stays `notified` and the
 * failure is written to `error` — because a refusal and a timeout are
 * indistinguishable from here, and the half of that pair where the message did
 * arrive must not be followed by a second one. The screen offers an explicit
 * "Try again" on a build in that state, which is a person deciding, not a
 * retry loop.
 */
export async function notifySiteBuildClient(
  db: Db,
  organisationId: string,
  input: NotifySiteBuildInput,
  email: EmailAdapter,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NotifySiteBuildResult> {
  const v = NotifySiteBuildInput.parse(input);

  const claim = await claimSiteBuild(db, organisationId, v);
  if (claim.alreadyNotified) return { sent: false, alreadyNotified: true, build: claim.build };

  const { build, recipient } = claim;
  const brand = brandEmailContext(env);
  const from = env.MAIL_FROM ?? supportEmailFor("hello", env);
  const websiteUrl = build.websiteUrl ?? `https://${build.domain}`;

  const { text, html } = renderBrandedEmail({
    preheader: "Your new website is ready to look at.",
    heading: "Your website is ready to look at",
    paragraphs: [
      `Hello ${recipient.name},`,
      ...(v.note ? [v.note] : []),
      "We have built a first version of your website. Have a look through it and tell us what you would like changed — nothing is set in stone, and it is not public until you are happy with it.",
      "It is on a temporary address for now. Your own domain goes on once you have signed it off.",
    ],
    cta: { label: "Look at your website", url: websiteUrl },
    footerNote: "Reply to this email with anything you want changed.",
    logoUrl: brand.logoUrl,
    appUrl: brand.appUrl,
    supportEmail: brand.supportEmail,
  });

  try {
    await email.send({
      to: recipient.email,
      from,
      subject: "Your new website is ready to look at",
      text,
      html,
    });
  } catch (error) {
    await recordSendFailure(db, organisationId, build, recipient, error).catch((bookkeeping: unknown) => {
      throw new AggregateError(
        [error, bookkeeping],
        `site build ${build.id} failed to send and the failure could not be recorded`,
      );
    });
    throw error;
  }

  await recordActivity(db, organisationId, {
    ...(recipient.clientId ? { clientId: recipient.clientId } : {}),
    actorKind: "user",
    actorId: v.actorId,
    kind: "site_build.notified",
    title: `${recipient.name} was sent their website to look at`,
    body: `${websiteUrl} was emailed to ${recipient.email}.`,
    link: "/site-builds",
  });

  return { sent: true, build, recipient };
}

type SiteBuildClaim =
  | { alreadyNotified: true; build: SiteBuildRow }
  | { alreadyNotified: false; build: SiteBuildRow; recipient: SiteBuildRecipient };

/**
 * Takes the build and its recipient in one transaction.
 *
 * The recipient is resolved *inside* it, so a lead with no address rolls the
 * claim back and leaves the build `approved` — an address is something a person
 * can go and fix, unlike a message already handed to a mail server.
 */
async function claimSiteBuild(
  db: Db,
  organisationId: string,
  v: z.output<typeof NotifySiteBuildInput>,
): Promise<SiteBuildClaim> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx
      .select()
      .from(schema.siteBuilds)
      .where(and(eq(schema.siteBuilds.id, v.buildId), eq(schema.siteBuilds.organisationId, organisationId)));
    if (!before) throw new Error("that build could not be found");

    // A successful send leaves no error. One that stayed on the row means the
    // last attempt did not get through, and a person has asked to try again.
    if (before.stage === "notified" && !before.error) {
      return { alreadyNotified: true as const, build: before };
    }
    if (before.stage !== "approved" && before.stage !== "notified") {
      throw new Error("a build has to be approved before the client can be told about it");
    }

    const recipient = await recipientFor(inner, organisationId, before);

    const [claimed] = await tx
      .update(schema.siteBuilds)
      .set({ stage: "notified", notifiedAt: now, error: null, updatedAt: now })
      .where(and(eq(schema.siteBuilds.id, v.buildId), eq(schema.siteBuilds.organisationId, organisationId)))
      .returning();

    await recordAudit(inner, organisationId, {
      actorKind: "user",
      actorId: v.actorId,
      action: "site_build.notified",
      targetType: "site_build",
      targetId: v.buildId,
      before: { stage: before.stage },
      after: { stage: "notified", to: recipient.email },
    });

    return { alreadyNotified: false as const, build: claimed!, recipient };
  });
}

/**
 * Who gets told: the client when the build has one, the enquiry otherwise.
 *
 * The client first on purpose. A lead that became a client may well have given
 * a personal address on the form and a proper one since, and the newer record
 * is the one somebody has maintained.
 */
async function recipientFor(db: Db, organisationId: string, build: SiteBuildRow): Promise<SiteBuildRecipient> {
  if (build.clientId) {
    const [client] = await db
      .select({ name: schema.clients.name, email: schema.clients.email })
      .from(schema.clients)
      .where(and(eq(schema.clients.id, build.clientId), eq(schema.clients.organisationId, organisationId)));
    if (!client?.email) throw new Error("that client has no email address to send to");
    return { name: client.name, email: client.email, clientId: build.clientId };
  }

  if (build.leadId) {
    const [lead] = await db
      .select({ name: schema.leads.name, email: schema.leads.email })
      .from(schema.leads)
      .where(and(eq(schema.leads.id, build.leadId), eq(schema.leads.organisationId, organisationId)));
    if (!lead?.email) throw new Error("that enquiry has no email address to send to");
    return { name: lead.name, email: lead.email, clientId: null };
  }

  throw new Error("that build has nobody to send to — it came from neither a client nor an enquiry");
}

/**
 * Records a send that did not get through, without giving the claim back.
 *
 * The stage stays `notified` and the words go on `error`, which is what puts
 * "Try again" back on the screen. Reverting to `approved` would look tidier and
 * would reopen the door a double-click walks through.
 */
async function recordSendFailure(
  db: Db,
  organisationId: string,
  build: SiteBuildRow,
  recipient: SiteBuildRecipient,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(schema.siteBuilds)
    .set({ error: `not emailed to ${recipient.email}: ${message}`, updatedAt: new Date() })
    .where(and(eq(schema.siteBuilds.id, build.id), eq(schema.siteBuilds.organisationId, organisationId)));

  await notifyOwner(db, organisationId, {
    kind: "site_build.send_failed",
    title: `${recipient.name} was not sent their website`,
    body: `Emailing ${build.domain} to ${recipient.email} failed: ${message}. The build is on the site builds screen with a Try again on it.`,
    link: "/site-builds",
  });
}
