"use server";

import { createEmailAdapter } from "@launchos/channels";
import { approveAdReport, createAdAccount, sendAdReport } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { type ActionResult, AddAdAccount, AdReportRef } from "./schemas";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** Server Actions accept direct POSTs, so every action re-authorises and re-validates. */
export async function addAdAccount(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = AddAdAccount.safeParse({
    clientId: formData.get("clientId"),
    platform: formData.get("platform"),
    externalId: formData.get("externalId"),
    name: formData.get("name"),
    currency: (formData.get("currency") as string | null)?.toUpperCase() || "GBP",
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid ad account" };

  try {
    const account = await createAdAccount(getDb(), session.organisationId, {
      ...parsed.data,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath("/ads");
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: account.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * The human gate on an outward-facing send. A report is drafted by the Ad
 * Performance Sentinel as `draft` and reaches `approved` only by a human
 * decision — either here, where a person reads it on /ads/reports and clicks
 * Approve, or on /approvals, where a person releases the Sentinel's
 * `reports_send_to_client` call after reading the same summary on the approval
 * card. `sendAdReport` refuses anything that is not approved at the instant it
 * claims the row. Approving here is deliberately not the send.
 */
export async function approveAdReportAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = AdReportRef.safeParse({ adReportId: formData.get("adReportId") });
  if (!parsed.success) return { status: "error", message: "Invalid report" };

  try {
    const report = await approveAdReport(getDb(), session.organisationId, {
      adReportId: parsed.data.adReportId,
      actorId: session.userId,
      actorKind: "user",
    });
    revalidatePath("/ads/reports");
    return { status: "ok", id: report.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/** Emails the client. Guarded by the report already being `approved` by a human. */
export async function sendAdReportAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = AdReportRef.safeParse({ adReportId: formData.get("adReportId") });
  if (!parsed.success) return { status: "error", message: "Invalid report" };

  try {
    const report = await sendAdReport(
      getDb(),
      session.organisationId,
      { adReportId: parsed.data.adReportId, actorId: session.userId, actorKind: "user" },
      createEmailAdapter(process.env),
      process.env.APP_URL ?? "http://localhost:3000",
    );
    revalidatePath("/ads/reports");
    revalidatePath(`/ads/${report.adAccountId}`);
    return { status: "ok", id: report.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
