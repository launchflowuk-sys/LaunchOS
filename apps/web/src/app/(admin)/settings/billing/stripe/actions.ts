"use server";

import { applyStripeSync, reconcileStripe } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getPayments } from "@/lib/integrations";
import { requirePermission } from "@/lib/permissions";
import { readImportForm } from "./import-form";
import { RESULT_PATH, REVIEW_PATH } from "./paths";

type ActionResult = { status: "ok" } | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Invalid selection";
  return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * The owner's import. Gated on `settings` like the rest of the module, and
 * re-parsed here because a Server Action accepts direct POSTs. The result
 * page reads the summary core stores on the organisation, so a successful
 * import redirects there rather than carrying the summary in the response.
 */
export async function importStripeAction(formData: FormData): Promise<void> {
  const gate = await requirePermission("settings");
  if (!gate.ok) redirect(`${REVIEW_PATH}?error=${encodeURIComponent(gate.message)}`);
  const { session } = gate;

  let form: ReturnType<typeof readImportForm>;
  try {
    form = readImportForm(formData);
  } catch {
    redirect(`${REVIEW_PATH}?error=${encodeURIComponent("Invalid product selection")}`);
  }

  // `redirect` throws, so it stays outside the try: a failure is carried out
  // as a message and redirected after. A "File under" pointing at a client
  // that is not ours is one such failure — core refuses before writing.
  let failure: string | null = null;
  try {
    await applyStripeSync(getDb(), session.organisationId, getPayments(), {
      ...form, actorKind: "user", actorId: session.userId,
    });
  } catch (error) {
    failure = errorMessage(error);
  }
  if (failure !== null) redirect(`${REVIEW_PATH}?error=${encodeURIComponent(failure)}`);
  revalidatePath("/settings/billing", "layout");
  revalidatePath("/settings/packages");
  revalidatePath("/clients", "layout");
  redirect(RESULT_PATH);
}

/**
 * "Sync now" on the Billing card: the stored selection re-applied, exactly
 * what the 04:10 cron does. Never links a new product — that is the review
 * screen's job — so it is safe to press at any time.
 */
export async function syncStripeNowAction(): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  try {
    await reconcileStripe(getDb(), session.organisationId, getPayments(), { actorId: session.userId });
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
  revalidatePath("/settings/billing", "layout");
  revalidatePath("/clients", "layout");
  return { status: "ok" };
}
