"use server";

import { publishClientReport } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

const ReportRef = z.object({ reportId: z.string().uuid() });

/** Server Actions accept direct POSTs, so every action re-authorises and re-validates. */
export async function publishReportAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = ReportRef.safeParse({ reportId: formData.get("reportId") });
  if (!parsed.success) return { status: "error", message: "Invalid report" };

  try {
    const report = await publishClientReport(getDb(), session.organisationId, {
      reportId: parsed.data.reportId,
      actorId: session.userId,
    });
    revalidatePath("/reports");
    revalidatePath(`/reports/${parsed.data.reportId}`);
    revalidatePath(`/clients/${report.clientId}/reports`);
    return { status: "ok", id: report.id };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
  }
}
