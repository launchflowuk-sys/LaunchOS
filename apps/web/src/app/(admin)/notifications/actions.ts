"use server";

import { markAllNotificationsRead, markNotificationRead } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const MarkOne = z.object({ notificationId: z.string().uuid() });

export type NotificationActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * Server Actions accept direct POSTs, so this authorises first and re-validates
 * the id. `safeParse`, not `parse`: a malformed id means a hand-crafted request,
 * and that should come back as a result the caller can show rather than a
 * ZodError escaping into Next's error page. The write itself is scoped to this
 * user's own notifications inside the service.
 */
export async function markNotificationReadAction(values: unknown): Promise<NotificationActionResult> {
  const session = await requireAdmin();
  const parsed = MarkOne.safeParse(values);
  if (!parsed.success) return { status: "error", message: "That notification could not be identified" };

  await markNotificationRead(getDb(), session.organisationId, {
    userId: session.userId,
    notificationId: parsed.data.notificationId,
  });
  revalidatePath("/", "layout");
  return { status: "ok" };
}

/**
 * The bell's `<form action>` binding. React types a form action as returning
 * `void`, so the result is dropped here; the point is that an invalid id no
 * longer throws.
 */
export async function markOneRead(formData: FormData): Promise<void> {
  await markNotificationReadAction({ notificationId: formData.get("notificationId") });
}

export async function markAllRead(): Promise<void> {
  const session = await requireAdmin();
  await markAllNotificationsRead(getDb(), session.organisationId, session.userId);
  revalidatePath("/", "layout");
}
