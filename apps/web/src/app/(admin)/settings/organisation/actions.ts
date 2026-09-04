"use server";

import { updateOrganisation } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { type ActionResult, readSupplierFields, UpdateOrganisationSchema } from "./schemas";

/**
 * Server Actions accept direct POSTs, so this re-authorises and re-validates
 * rather than trusting that the form was only rendered for an owner. Supplier
 * details are what every invoice is raised under — a staff member should not be
 * able to change the VAT number the agency bills on.
 */
export async function updateOrganisationAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  if (session.role !== "owner") {
    return { status: "error", message: "Only an owner can change the organisation's details" };
  }

  const parsed = UpdateOrganisationSchema.safeParse(readSupplierFields(formData));
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid details" };
  }

  try {
    await updateOrganisation(getDb(), session.organisationId, {
      ...parsed.data,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath("/settings/organisation");
    // Every printable invoice renders these, so both print views go stale.
    revalidatePath("/invoices", "layout");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
  }
}
