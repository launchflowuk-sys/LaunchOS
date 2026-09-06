"use server";

import { createPackage, updatePackage } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import {
  type ActionResult, CreatePackageSchema, readIncludes, readPackageBase, UpdatePackageSchema,
} from "./schemas";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** Server Actions accept direct POSTs, so every action re-authorises and re-validates. */
export async function createPackageAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = CreatePackageSchema.safeParse({
    ...readPackageBase(formData),
    slug: formData.get("slug"),
    includes: readIncludes(formData),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid package" };
  const v = parsed.data;

  try {
    const pkg = await createPackage(getDb(), session.organisationId, {
      name: v.name,
      slug: v.slug,
      ...(v.description ? { description: v.description } : {}),
      monthlyPricePence: v.monthlyPricePence,
      setupPricePence: v.setupPricePence,
      includes: v.includes,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath("/settings/packages");
    revalidatePath("/clients");
    return { status: "ok", id: pkg.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function updatePackageAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = UpdatePackageSchema.safeParse({
    ...readPackageBase(formData),
    packageId: formData.get("packageId"),
    active: formData.get("active") === "on",
    includes: readIncludes(formData),
    stripePriceId: formData.get("stripePriceId") ?? "",
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid package" };
  const v = parsed.data;

  try {
    const pkg = await updatePackage(getDb(), session.organisationId, {
      packageId: v.packageId,
      name: v.name,
      // An emptied textarea means "no description", not "leave it alone".
      description: v.description ?? null,
      monthlyPricePence: v.monthlyPricePence,
      setupPricePence: v.setupPricePence,
      includes: v.includes,
      active: v.active,
      stripePriceId: v.stripePriceId,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath("/settings/packages");
    revalidatePath("/clients");
    return { status: "ok", id: pkg.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
