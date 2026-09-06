import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { AGREEMENT_EVIDENCE_FIELDS } from "../documents/acceptance.js";
import { notifyOwner } from "../notifications/notify.js";
import { deliverProject } from "../projects/deliver.js";
import { ProjectRefused, type ProjectRow } from "../projects/shared.js";
import { isUniqueViolation } from "../proposals/shared.js";
import { buildDeliveryReport, type DeliveryReport } from "./report.js";
import {
  DELIVERY_TARGET_TYPE,
  DeliveryRefused,
  SIGN_OFF_TARGET_TYPE,
  getDeliverySignOff,
  getProjectBySignOffToken,
  normaliseSignOffToken,
  type DeliverySignOffRow,
} from "./shared.js";

/**
 * A client signing off a finished build.
 *
 * This is `acceptProposal` for the other end of the job, and it is the same
 * three properties in the same order, because they are the properties that
 * make a recorded agreement trustworthy rather than a nice-to-have:
 *
 * 1. **It happens once.** The unique index on `delivery_sign_offs.project_id`
 *    decides that, not a read-then-insert — a client on a phone taps Sign off
 *    twice inside 40 ms and both requests pass a read check. The second insert
 *    loses to the index and this returns the *first* sign-off with
 *    `alreadySignedOff: true`.
 * 2. **It is one transaction.** The sign-off row, the audit trail and the
 *    client's timeline entry commit together or not at all.
 * 3. **It does not do the slow half inline.** Delivering the project fires the
 *    owner's bell, the `project.delivered` event, the Case Study Writer and
 *    the care plan; countersigning needs Chromium. Both happen after the
 *    commit, and neither can lose the client's signature by failing.
 */

export const DELIVERY_SIGNED_OFF_NOTIFICATION_KIND = "delivery.signed_off";

export const SignOffDeliveryInput = z.object({
  /** The public token out of the URL — never an id. */
  token: z.string().min(1),
  signedName: z.string().trim().min(1, "please type your name").max(160),
  signedEmail: z.string().trim().email("that does not look like an email address").max(320),
  ...AGREEMENT_EVIDENCE_FIELDS,
  now: z.date().optional(),
});
export type SignOffDeliveryInput = z.input<typeof SignOffDeliveryInput>;

export interface SignOffDeliveryResult {
  project: ProjectRow;
  signOff: DeliverySignOffRow;
  /** True when this call found a sign-off already there and wrote nothing. */
  alreadySignedOff: boolean;
  /** True when this call is the one that closed the project. */
  delivered: boolean;
}

/**
 * The report as the public page shows it, found by token alone.
 *
 * Null for an unknown or malformed token, so the page answers 404 without
 * telling a guesser whether they were close. The organisation comes from the
 * row, never from the request.
 */
export async function getPublicDeliveryReport(db: Db, token: string): Promise<DeliveryReport | null> {
  const project = await getProjectBySignOffToken(db, token);
  if (!project) return null;
  return buildDeliveryReport(db, project.organisationId, { projectId: project.id });
}

/**
 * Records a client's sign-off.
 *
 * The project is found by token *and* organisation, so a token minted for one
 * tenant matches nothing in another; everything after that reads from the row
 * rather than from the caller.
 */
export async function signOffDelivery(
  db: Db,
  organisationId: string,
  input: SignOffDeliveryInput,
): Promise<SignOffDeliveryResult> {
  const v = SignOffDeliveryInput.parse(input);
  const token = normaliseSignOffToken(v.token);
  if (!token) throw new DeliveryRefused("not_found", "That handover could not be found.");
  const now = v.now ?? new Date();

  const [before] = await db.select().from(schema.projects)
    .where(and(
      eq(schema.projects.signOffToken, token),
      eq(schema.projects.organisationId, organisationId),
      isNull(schema.projects.deletedAt),
    ));
  if (!before) throw new DeliveryRefused("not_found", "That handover could not be found.");
  if (before.status === "cancelled") {
    throw new DeliveryRefused("not_signable", `${before.name} was cancelled — there is nothing to sign off.`);
  }

  // The cheap half of idempotency: a page reloaded an hour later never gets as
  // far as the index.
  const existing = await getDeliverySignOff(db, organisationId, before.id);
  if (existing) return { project: before, signOff: existing, alreadySignedOff: true, delivered: false };

  let committed;
  try {
    committed = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [signOff] = await tx.insert(schema.deliverySignOffs).values({
        organisationId,
        projectId: before.id,
        signedName: v.signedName,
        signedEmail: v.signedEmail.toLowerCase(),
        signedAt: now,
        ip: v.ip ?? null,
        userAgent: v.userAgent ?? null,
        signatureSvg: v.signatureSvg ?? null,
        // The *countersigned* copy, exactly as on `proposal_acceptances`:
        // null until the worker renders it. What they read before signing is
        // `projects.delivery_report_document_id`, and it stays that document,
        // so both the file they were shown and the file they signed survive.
        documentId: null,
      }).returning();

      await recordAudit(tx, organisationId, {
        actorKind: "client", action: "delivery_report.signed_off",
        targetType: DELIVERY_TARGET_TYPE, targetId: before.id, after: signOff,
      });
      await recordAudit(tx, organisationId, {
        actorKind: "client", action: "delivery_sign_off.recorded",
        targetType: SIGN_OFF_TARGET_TYPE, targetId: signOff!.id, after: signOff,
      });
      await recordActivity(tx, organisationId, {
        clientId: before.clientId, actorKind: "client", kind: "delivery_report.signed_off",
        title: `${before.name} signed off by ${v.signedName}`,
        link: `/projects/${before.id}`,
      });
      return signOff!;
    });
  } catch (error) {
    // The index had the final word: another request wrote the sign-off while
    // this one was in flight. Their record stands.
    if (isUniqueViolation(error)) {
      const winner = await getDeliverySignOff(db, organisationId, before.id);
      if (winner) return { project: before, signOff: winner, alreadySignedOff: true, delivered: false };
    }
    throw error;
  }

  await notifyOwner(db, organisationId, {
    kind: DELIVERY_SIGNED_OFF_NOTIFICATION_KIND,
    title: `${before.name} signed off by ${v.signedName}`,
    body: "The build is handed over and the care plan starts now.",
    link: `/projects/${before.id}`,
  });

  const delivered = await closeProject(db, organisationId, before, now);
  const [after] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, before.id), eq(schema.projects.organisationId, organisationId)));

  return { project: after ?? before, signOff: committed, alreadySignedOff: false, delivered };
}

/**
 * Closing the project — and everything the rest of LaunchOS hangs off that.
 *
 * `deliverProject` is reused whole: it stamps the delivery date under a
 * `deliveredAt IS NULL` guard, moves the case study to `live`, rings the bell
 * and emits `project.delivered`, which is what already triggers the Case Study
 * Writer and the launch screenshots. Writing a second version of that here
 * would mean two paths to the same state, and one of them would drift.
 *
 * A project Shoji had already marked delivered by hand is not an error — the
 * client is signing off work that is genuinely finished — so
 * `already_delivered` is swallowed and reported as `delivered: false`. Any
 * other failure is logged rather than thrown: the signature is committed, and
 * losing it because a notification could not be written would be the wrong
 * trade by a distance.
 */
async function closeProject(db: Db, organisationId: string, project: ProjectRow, now: Date): Promise<boolean> {
  if (project.deliveredAt) return false;
  try {
    await deliverProject(db, organisationId, {
      projectId: project.id,
      deliveredAt: now,
      note: "Signed off by the client from their handover report.",
      actorKind: "client",
    });
    return true;
  } catch (error) {
    if (error instanceof ProjectRefused && error.reason === "already_delivered") return false;
    console.error(
      { organisationId, projectId: project.id, error: error instanceof Error ? error.message : String(error) },
      "delivery signed off but the project could not be closed; the sign-off is recorded",
    );
    return false;
  }
}
