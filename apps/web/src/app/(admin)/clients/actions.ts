"use server";

import {
  archiveClient, createClient, createContact, createDomain, createSite, deleteContact, upsertBillingProfile,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";
import {
  BillingSchema, NewClientSchema, NewContactSchema, NewDomainSchema, NewSiteSchema,
  type ActionResult, type BillingValues, type NewClientValues, type NewContactValues, type NewDomainValues, type NewSiteValues,
} from "./schemas";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** Turns a service throw into a message the dialog can show, never a 500 page. */
function failed(error: unknown): ActionResult {
  return { status: "error", message: messageFor(error) };
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

const ArchiveInput = z.object({ clientId: z.string().uuid() });

/**
 * A plain `<form action>` submit, so it cannot return an ActionResult the way
 * the dialogs do. A failure is therefore carried back on the URL and rendered
 * as a banner rather than swallowed or thrown into a 500 page. `redirect`
 * signals by throwing, so it must run outside the try block.
 */
export async function archiveClientAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const { clientId } = ArchiveInput.parse({ clientId: formData.get("clientId") });

  let failure: string | null = null;
  try {
    await archiveClient(getDb(), session.organisationId, { clientId, actorKind: "user", actorId: session.userId });
  } catch (error) {
    failure = messageFor(error);
  }
  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`);
  if (failure) redirect(`/clients/${clientId}?error=${encodeURIComponent(failure)}`);
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

const DeleteContactFormInput = z.object({ contactId: z.string().uuid(), clientId: z.string().uuid() });

export async function deleteContactAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const { contactId, clientId } = DeleteContactFormInput.parse({
    contactId: formData.get("contactId"),
    clientId: formData.get("clientId"),
  });

  let failure: string | null = null;
  try {
    await deleteContact(getDb(), session.organisationId, { contactId, actorKind: "user", actorId: session.userId });
  } catch (error) {
    failure = messageFor(error);
  }
  revalidatePath(`/clients/${clientId}`);
  if (failure) redirect(`/clients/${clientId}?tab=contacts&error=${encodeURIComponent(failure)}`);
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
