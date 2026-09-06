"use server";

import { setAssignmentRules, updateOrganisation } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { type ActionResult, AssignmentRulesSchema, readSupplierFields, UpdateOrganisationSchema } from "./schemas";

/**
 * Core validates the shape of the fields with legal weight (the VAT number,
 * the country, the postcode), so its refusal is the message worth showing —
 * a raw `ZodError` stringifies to a JSON blob in the toast.
 */
function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Invalid details";
  return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * Server Actions accept direct POSTs, so this re-authorises and re-validates
 * rather than trusting that the form was only rendered for an owner. Supplier
 * details are what every invoice is raised under — a staff member should not be
 * able to change the VAT number the agency bills on.
 */
export async function updateOrganisationAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  if (session.role !== "owner") {
    return { status: "error", message: "Only an owner can change the organisation's details" };
  }

  const read = readSupplierFields(formData);
  if (read.status === "incomplete") {
    return {
      status: "error",
      message: `This form was posted without ${read.missing.join(", ")} — nothing was saved. Submit the whole form.`,
    };
  }

  const parsed = UpdateOrganisationSchema.safeParse(read.values);
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
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * How new support cases and generated tasks find an owner. Gated by
 * `settings` (not owner-only: a manager with the settings permission may
 * run the rota). Core merges the two rules into `organisations.metadata`,
 * leaving the round-robin cursor alone, and audits the change.
 */
export async function updateAssignmentRulesAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;

  const parsed = AssignmentRulesSchema.safeParse({
    support: formData.get("support"),
    tasks: formData.get("tasks"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid assignment rules" };

  try {
    await setAssignmentRules(getDb(), session.organisationId, { rules: parsed.data, actorId: session.userId });
    revalidatePath("/settings/organisation");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
