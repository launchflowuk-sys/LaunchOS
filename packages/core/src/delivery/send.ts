import { renderPdf, type RenderPdfInput } from "@launchos/channels/pdf";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress } from "../config.js";
import { signedDocumentUrl } from "../documents/document-link.js";
import { storeDocument, type DocumentRow } from "../documents/store-document.js";
import { emit } from "../events/emit.js";
import { projectUpdateRecipients } from "../projects/update-approval.js";
import { ActorKindSchema } from "../proposals/shared.js";
import { DELIVERY_NOTICE_KIND } from "../support/courtesy-notice.js";
import { deliveryReportReference, deliveryReportRenderInput, deliveryReportTitle } from "./document.js";
import { buildDeliveryReport, type DeliveryReport } from "./report.js";
import {
  DELIVERY_DOCUMENT_KIND,
  DELIVERY_SUBJECT_TYPE,
  DELIVERY_TARGET_TYPE,
  DeliveryRefused,
  deliverySignOffUrl,
  mintSignOffToken,
} from "./shared.js";

/**
 * Sending the handover: render it, keep it, and ask the client to sign it off.
 *
 * **The renderer is a dependency**, exactly as it is for a proposal and for
 * the same reason: `playwright` is a dependency of `apps/worker` and not of
 * `apps/web`, so a send that reached for a browser from a route handler would
 * work on a laptop and fail on Coolify. Tests get the mock free, because
 * `pdfRendererKind` returns `mock` under `NODE_ENV=test`.
 *
 * The render and the file write happen outside the transaction, for the same
 * reason `sendProposal` does it that way: a browser call and a disk write must
 * not hold a database lock, and a failed send costs an orphan file rather than
 * a half-written record.
 */

/** What sending a delivery report needs from the outside world. */
export interface DeliveryDeps {
  render?: ((input: RenderPdfInput) => Promise<Uint8Array<ArrayBuffer>>) | undefined;
}

const renderer = (deps: DeliveryDeps | undefined) => deps?.render ?? ((input: RenderPdfInput) => renderPdf(input));

export const RenderDeliveryReportInput = z.object({
  projectId: z.string().uuid(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
});
export type RenderDeliveryReportInput = z.input<typeof RenderDeliveryReportInput>;

export interface RenderDeliveryReportResult {
  report: DeliveryReport;
  document: DocumentRow;
  /** The signed, expiring link to the PDF. */
  documentUrl: string;
  /** The public page the client reads and signs off on. */
  signOffUrl: string;
}

/**
 * Renders the report, files it against the project, and mints the sign-off
 * token if this is the first time.
 *
 * Re-rendering before sign-off is allowed and replaces the stored document:
 * until the client has signed there is only one current version of what they
 * are being asked to agree to, and a fix to a wrong URL should not leave two
 * documents both claiming to be the handover. Once a sign-off exists the
 * document is evidence and this refuses — the countersigned copy is a second
 * document, written by the sign-off itself.
 *
 * **The token is minted once and kept.** A re-render must not invalidate the
 * link already sitting in the client's inbox.
 */
export async function renderDeliveryReport(
  db: Db,
  organisationId: string,
  input: RenderDeliveryReportInput,
  deps?: DeliveryDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RenderDeliveryReportResult> {
  const v = RenderDeliveryReportInput.parse(input);
  const report = await buildDeliveryReport(db, organisationId, { projectId: v.projectId });
  if (report.signOff) {
    throw new DeliveryRefused("not_signable", `${report.project.name} has already been signed off — its report is evidence now.`);
  }

  const bytes = await renderer(deps)(deliveryReportRenderInput(report, env));
  const document = await storeDocument(db, organisationId, {
    kind: DELIVERY_DOCUMENT_KIND,
    title: deliveryReportTitle(report),
    reference: deliveryReportReference(report.project),
    clientId: report.project.clientId,
    subjectType: DELIVERY_SUBJECT_TYPE,
    subjectId: report.project.id,
    bytes,
    actorKind: v.actorKind,
    ...(v.actorId ? { actorId: v.actorId } : {}),
  }, env);

  const token = report.project.signOffToken ?? mintSignOffToken();
  const [after] = await db.update(schema.projects)
    .set({ deliveryReportDocumentId: document.id, signOffToken: token, updatedAt: new Date() })
    .where(and(eq(schema.projects.id, report.project.id), eq(schema.projects.organisationId, organisationId)))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "delivery_report.rendered",
    targetType: DELIVERY_TARGET_TYPE, targetId: report.project.id,
    before: report.project, after,
  });

  return {
    report: { ...report, project: after! },
    document,
    documentUrl: signedDocumentUrl({ organisationId, documentId: document.id }, env),
    signOffUrl: deliverySignOffUrl(after!, env),
  };
}

export const SendDeliveryReportInput = RenderDeliveryReportInput;
export type SendDeliveryReportInput = z.input<typeof SendDeliveryReportInput>;

export interface SendDeliveryReportResult extends RenderDeliveryReportResult {
  /** One queued row per portal address on the client. */
  messages: (typeof schema.messages.$inferSelect)[];
}

/** The body of the email that carries a handover out. Plain, and short. */
export function deliveryNoticeBody(input: {
  clientName: string;
  projectName: string;
  signOffUrl: string;
  documentUrl: string;
}): string {
  return [
    `Hello ${input.clientName},`,
    `${input.projectName} is finished. Your handover report is attached to this email as a link — it says what we built, where it lives, what we look after from here, and where your logins are kept.`,
    `Read it over, then sign it off here: ${input.signOffUrl}`,
    `You can also open the PDF straight away: ${input.documentUrl}`,
    "Signing it off is what starts your care plan. If anything in it looks wrong, reply to this email instead and we will put it right first.",
  ].join("\n\n");
}

/**
 * Renders the report and queues it to every portal address on the client.
 *
 * Queued rather than sent, like every other client email: an SMTP call cannot
 * be rolled back and a row can, so the record of what we told them commits
 * first and the worker's sender does the rest.
 *
 * `sign_off_sent_at` is stamped by the same statement that queues the mail,
 * so the admin page can say "sent, waiting on them" honestly. A second send is
 * allowed — a client who lost the email needs another one — and re-stamps it.
 */
export async function sendDeliveryReport(
  db: Db,
  organisationId: string,
  input: SendDeliveryReportInput,
  deps?: DeliveryDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SendDeliveryReportResult> {
  const v = SendDeliveryReportInput.parse(input);
  const rendered = await renderDeliveryReport(db, organisationId, v, deps, env);
  const project = rendered.report.project;

  const recipients = await projectUpdateRecipients(db, organisationId, project.clientId);
  if (recipients.length === 0) {
    throw new DeliveryRefused("no_recipient", "There is nobody on this client with an email address to send the handover to.");
  }

  const now = new Date();
  const subject = `${project.name} — your handover`;
  const body = deliveryNoticeBody({
    clientName: rendered.report.clientName,
    projectName: project.name,
    signOffUrl: rendered.signOffUrl,
    documentUrl: rendered.documentUrl,
  });

  const queued = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [conversation] = await tx.insert(schema.conversations).values({
      organisationId,
      clientId: project.clientId,
      subject,
      channel: "email",
      status: "closed",
      lastMessageAt: now,
    }).returning();

    const messages: (typeof schema.messages.$inferSelect)[] = [];
    for (const to of recipients) {
      const [message] = await tx.insert(schema.messages).values({
        organisationId,
        conversationId: conversation!.id,
        direction: "outbound",
        authorKind: "system",
        authorId: null,
        body,
        fromEmail: brandSupportAddress(env),
        toEmail: to.toLowerCase(),
        subject,
        status: "queued",
        metadata: {
          kind: DELIVERY_NOTICE_KIND,
          projectId: project.id,
          signOffUrl: rendered.signOffUrl,
          documentUrl: rendered.documentUrl,
          documentId: rendered.document.id,
        },
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: "system", action: "message.queued", targetType: "message", targetId: message!.id, after: message,
      });
      messages.push(message!);
    }

    await tx.update(schema.projects)
      .set({ signOffSentAt: now, updatedAt: now })
      .where(and(
        eq(schema.projects.id, project.id),
        eq(schema.projects.organisationId, organisationId),
        isNull(schema.projects.deletedAt),
      ));
    await recordActivity(tx, organisationId, {
      clientId: project.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "delivery_report.sent",
      title: `Handover for ${project.name} sent to ${recipients.join(", ")}`,
      link: `/projects/${project.id}`,
    });
    return messages;
  });

  for (const message of queued) {
    await emit({ name: "message.queued", organisationId, messageId: message.id });
  }
  return { ...rendered, messages: queued };
}

/**
 * The countersigned copy — the same report with the sign-off block on it,
 * filed against `delivery_sign_offs.document_id`. That column is the stamp: a
 * second run finds it set and renders nothing, exactly as the proposal's
 * countersigning does.
 */
export async function countersignDeliveryReport(
  db: Db,
  organisationId: string,
  input: { projectId: string },
  deps?: DeliveryDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentRow | null> {
  const report = await buildDeliveryReport(db, organisationId, input);
  if (!report.signOff) throw new DeliveryRefused("not_signable", `${report.project.name} has not been signed off.`);
  if (report.signOff.documentId) return null;

  const bytes = await renderer(deps)(deliveryReportRenderInput(report, env));
  const document = await storeDocument(db, organisationId, {
    kind: DELIVERY_DOCUMENT_KIND,
    title: deliveryReportTitle(report),
    reference: deliveryReportReference(report.project),
    clientId: report.project.clientId,
    subjectType: DELIVERY_SUBJECT_TYPE,
    subjectId: report.project.id,
    bytes,
    actorKind: "system",
  }, env);

  const [after] = await db.update(schema.deliverySignOffs)
    .set({ documentId: document.id, updatedAt: new Date() })
    .where(and(
      eq(schema.deliverySignOffs.id, report.signOff.id),
      eq(schema.deliverySignOffs.organisationId, organisationId),
      isNull(schema.deliverySignOffs.documentId),
    ))
    .returning();
  if (!after) return null;
  await recordAudit(db, organisationId, {
    actorKind: "system", action: "delivery_report.countersigned",
    targetType: "delivery_sign_off", targetId: report.signOff.id, before: report.signOff, after,
  });
  return document;
}
