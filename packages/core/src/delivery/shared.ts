import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { appUrl } from "../config.js";
import { mintPublicToken, normalisePublicToken } from "../documents/acceptance.js";
import type { DocumentKind } from "../documents/store-document.js";
import type { ProjectRow } from "../projects/shared.js";

/**
 * The delivery report: rows, refusals and the lookups every module in this
 * folder needs.
 *
 * The shape follows `proposals/shared.ts` deliberately, because the two
 * documents work the same way — a compiled PDF on the shared letterhead, a
 * token-only public page, one recorded agreement — and the second of anything
 * here would be the beginning of two mechanisms instead of one.
 */

export type DeliverySignOffRow = typeof schema.deliverySignOffs.$inferSelect;

/** Everything a delivery report can refuse to do, and the message the caller shows. */
export class DeliveryRefused extends Error {
  constructor(
    readonly reason:
      | "not_found"
      | "not_ready"
      | "no_recipient"
      | "not_signable"
      | "not_sent",
    message: string,
  ) {
    super(message);
    this.name = "DeliveryRefused";
  }
}

/** The audit target type every delivery-report action is recorded under. */
export const DELIVERY_TARGET_TYPE = "delivery_report";
/** `documents.subject_type` — the subject is the project the report is about. */
export const DELIVERY_SUBJECT_TYPE = "delivery_report";
/** How the rendered report is filed. The kind already exists on `documents`. */
export const DELIVERY_DOCUMENT_KIND: DocumentKind = "delivery_report";
/** The audit target type a sign-off is recorded under. */
export const SIGN_OFF_TARGET_TYPE = "delivery_sign_off";

/**
 * The public page the report is read and signed off on — the same shape as a
 * proposal's `/p/<token>`, on both hosts, token-only and rate-limited.
 */
export const DELIVERY_PUBLIC_PATH = "/d";

/** A fresh sign-off token. The same 192 bits as a proposal's, from one place. */
export function mintSignOffToken(): string {
  return mintPublicToken();
}

/** A trimmed token, or null when the string could not be one. */
export function normaliseSignOffToken(token: string): string | null {
  return normalisePublicToken(token);
}

/** Where the client reads the report and signs it off. */
export function deliverySignOffUrl(project: Pick<ProjectRow, "signOffToken">, env: NodeJS.ProcessEnv = process.env): string {
  if (!project.signOffToken) throw new DeliveryRefused("not_sent", "This project has no delivery report to sign off yet.");
  return `${appUrl(env)}${DELIVERY_PUBLIC_PATH}/${encodeURIComponent(project.signOffToken)}`;
}

/** The sign-off, if the client has signed. One per project, by index. */
export async function getDeliverySignOff(db: Db, organisationId: string, projectId: string): Promise<DeliverySignOffRow | null> {
  const [row] = await db
    .select()
    .from(schema.deliverySignOffs)
    .where(and(
      eq(schema.deliverySignOffs.projectId, projectId),
      eq(schema.deliverySignOffs.organisationId, organisationId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * By the public token, across organisations — the public page has no
 * organisation until it has found the project, exactly as the proposal page
 * has none until it has found the proposal.
 */
export async function getProjectBySignOffToken(db: Db, token: string): Promise<ProjectRow | null> {
  const normalised = normaliseSignOffToken(token);
  if (!normalised) return null;
  const [row] = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.signOffToken, normalised), isNull(schema.projects.deletedAt)))
    .limit(1);
  return row ?? null;
}
