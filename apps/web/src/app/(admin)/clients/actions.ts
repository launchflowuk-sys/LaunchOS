"use server";

import {
  archiveClient, createClient, createContact, createDomain, createSite, deleteContact, updateClient, upsertBillingProfile,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";
import {
  BillingSchema, ClientDetailsSchema, NewClientSchema, NewContactSchema, NewDomainSchema, NewSiteSchema,
  type ActionResult, type BillingValues, type ClientDetailsValues, type NewClientValues, type NewContactValues, type NewDomainValues, type NewSiteValues,
} from "./schemas";

/** Turns a service throw into a message the caller can show, never a 500 page. */
function failed(error: unknown): ActionResult {
  return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
}

export async function createClientAction(values: NewClientValues): Promise<ActionResult> {
  // Server Actions accept direct POSTs: authorise, then re-validate the same
  // schema the browser used.
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = NewClientSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid details" };

  try {
    const client = await createClient(getDb(), session.organisationId, {
      ...parsed.data,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath("/clients");
    return { status: "ok", id: client.id };
  } catch (error) {
    return failed(error);
  }
}

/**
 * The name, trading name and contact details on the Overview tab. `slug`,
 * `supportEmail` and `status` are not here: mail routes to the first two,
 * and Archive is the one status change with its own button. Core audits the
 * write as `client.updated`.
 */
export async function updateClientDetailsAction(values: ClientDetailsValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = ClientDetailsSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid details" };

  try {
    const client = await updateClient(getDb(), session.organisationId, {
      ...parsed.data,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath("/clients");
    revalidatePath(`/clients/${client.id}`, "layout");
    return { status: "ok", id: client.id };
  } catch (error) {
    return failed(error);
  }
}

const ArchiveInput = z.object({ clientId: z.string().uuid() });
export type ArchiveClientValues = z.input<typeof ArchiveInput>;

/**
 * Called from a button, not a `<form action>`, so the caller can show the
 * failure. Validation uses safeParse for the same reason the writes are
 * wrapped: a malformed id is a message, never Next's error page.
 */
export async function archiveClientAction(values: ArchiveClientValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = ArchiveInput.safeParse(values);
  if (!parsed.success) return { status: "error", message: "That client could not be identified" };

  try {
    const client = await archiveClient(getDb(), session.organisationId, {
      clientId: parsed.data.clientId, actorKind: "user", actorId: session.userId,
    });
    revalidatePath("/clients");
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: client.id };
  } catch (error) {
    return failed(error);
  }
}

export async function createContactAction(values: NewContactValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = NewContactSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid contact" };
  try {
    const contact = await createContact(getDb(), session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: contact.id };
  } catch (error) {
    return failed(error);
  }
}

const DeleteContactInput = z.object({ contactId: z.string().uuid(), clientId: z.string().uuid() });
export type DeleteContactValues = z.input<typeof DeleteContactInput>;

export async function deleteContactAction(values: DeleteContactValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = DeleteContactInput.safeParse(values);
  if (!parsed.success) return { status: "error", message: "That contact could not be identified" };

  try {
    await deleteContact(getDb(), session.organisationId, {
      contactId: parsed.data.contactId, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: parsed.data.contactId };
  } catch (error) {
    return failed(error);
  }
}

export async function saveBillingAction(values: BillingValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = BillingSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid billing details" };
  try {
    const profile = await upsertBillingProfile(getDb(), session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: profile.id };
  } catch (error) {
    return failed(error);
  }
}

export async function createSiteAction(values: NewSiteValues): Promise<ActionResult> {
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = NewSiteSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid website" };
  try {
    const site = await createSite(getDb(), session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    revalidatePath("/websites");
    return { status: "ok", id: site.id };
  } catch (error) {
    return failed(error);
  }
}

export async function createDomainAction(values: NewDomainValues): Promise<ActionResult> {
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = NewDomainSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid domain" };
  try {
    const domain = await createDomain(getDb(), session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    revalidatePath("/domains");
    return { status: "ok", id: domain.id };
  } catch (error) {
    return failed(error);
  }
}
