"use server";

import { createDnsRecord, deleteDnsRecord, updateDomain } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import {
  AttachSiteSchema,
  type ActionResult,
  type AttachSiteValues,
  DeleteDnsRecordSchema,
  type DeleteDnsRecordValues,
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
