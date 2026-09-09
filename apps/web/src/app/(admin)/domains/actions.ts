"use server";

import { createDnsRecord, deleteDnsRecord, deleteDomain, getDomain, updateDomain } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import {
  AttachSiteSchema,
  type ActionResult,
  type AttachSiteValues,
  DeleteDnsRecordSchema,
  type DeleteDnsRecordValues,
  DeleteDomainSchema,
  MoveDomainSchema,
  NewDnsRecordSchema,
  type NewDnsRecordValues,
} from "./schemas";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

export async function createDnsRecordAction(values: NewDnsRecordValues): Promise<ActionResult> {
  // Server Actions accept direct POSTs: authorise, then re-validate.
  const session = await requireAdmin();
  const parsed = NewDnsRecordSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid record" };
  try {
    const record = await createDnsRecord(getDb(), session.organisationId, {
      ...parsed.data,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath(`/domains/${parsed.data.domainId}`);
    return { status: "ok", id: record.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Bound to a plain button's onClick from a client component rather than a
 * `<form action>` — that lets us hand the ActionResult back to the caller so
 * the error can be toasted instead of surfacing as an uncaught server error.
 */
export async function deleteDnsRecordAction(values: DeleteDnsRecordValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = DeleteDnsRecordSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid request" };
  try {
    await deleteDnsRecord(getDb(), session.organisationId, {
      recordId: parsed.data.recordId,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath(`/domains/${parsed.data.domainId}`);
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function attachDomainToSiteAction(values: AttachSiteValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = AttachSiteSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid request" };
  try {
    await updateDomain(getDb(), session.organisationId, {
      domainId: parsed.data.domainId,
      siteId: parsed.data.siteId === "" ? null : parsed.data.siteId,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath(`/domains/${parsed.data.domainId}`);
    revalidatePath("/domains");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Move a domain to another client.
 *
 * The case this exists for: a domain added by hand against the wrong client,
 * whose client is then archived. Archiving does not release the name and the
 * unique index refuses a second row, so without a move the name is stuck.
 */
export async function moveDomainAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = MoveDomainSchema.safeParse({
    domainId: formData.get("domainId"),
    clientId: formData.get("clientId"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid client" };
  try {
    await updateDomain(getDb(), session.organisationId, {
      domainId: parsed.data.domainId,
      clientId: parsed.data.clientId,
      actorKind: "user",
      actorId: session.userId,
    });
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
  revalidatePath(`/domains/${parsed.data.domainId}`);
  revalidatePath("/domains");
  return { status: "ok" };
}

/** Delete a domain and its DNS records. The typed name is the confirmation. */
export async function deleteDomainAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = DeleteDomainSchema.safeParse({
    domainId: formData.get("domainId"),
    confirmName: formData.get("confirmName"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid request" };

  const db = getDb();
  const domain = await getDomain(db, session.organisationId, parsed.data.domainId);
  if (!domain) return { status: "error", message: "Domain not found" };
  // Compared case-insensitively and trimmed: a domain name is not case
  // sensitive and neither is the person typing it at two in the morning.
  if (parsed.data.confirmName.trim().toLowerCase() !== domain.name.toLowerCase()) {
    return { status: "error", message: `Type ${domain.name} exactly to delete it` };
  }

  try {
    await deleteDomain(db, session.organisationId, {
      domainId: parsed.data.domainId, actorKind: "user", actorId: session.userId,
    });
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
  revalidatePath("/domains");
  // Redirect rather than return: the page this was submitted from is
  // `/domains/<id>`, and that row no longer exists — staying put turned a
  // successful delete into a 404. `redirect` throws, so it must sit outside
  // the try above or the catch would report the navigation as a failure.
  redirect("/domains");
}
