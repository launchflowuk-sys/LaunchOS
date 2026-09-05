"use server";

import { recordPayment } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { type ActionResult, RecordPaymentSchema } from "./schemas";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** Server Actions accept direct POSTs, so this re-authorises and re-validates. */
export async function recordManualPayment(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = RecordPaymentSchema.safeParse({
    clientId: value(formData, "clientId"),
    invoiceId: value(formData, "invoiceId"),
    amountPounds: value(formData, "amountPounds"),
    provider: value(formData, "provider"),
    providerRef: value(formData, "providerRef"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid payment" };
  const v = parsed.data;

  try {
    // recordPayment reconciles the invoice when one is chosen: once the
    // succeeded payments cover the total, the invoice marks itself paid.
    const payment = await recordPayment(getDb(), session.organisationId, {
      clientId: v.clientId,
      ...(v.invoiceId ? { invoiceId: v.invoiceId } : {}),
      // Pounds in the form, pence in the database — rounded once, here.
      amountPence: Math.round(v.amountPounds * 100),
      provider: v.provider,
      ...(v.providerRef ? { providerRef: v.providerRef } : {}),
      status: "succeeded",
      actorKind: "user",
      actorId: session.userId,
    });

    revalidatePath("/payments");
    revalidatePath("/invoices");
    if (v.invoiceId) revalidatePath(`/invoices/${v.invoiceId}`);
    revalidatePath(`/clients/${v.clientId}`);
    return { status: "ok", id: payment.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
