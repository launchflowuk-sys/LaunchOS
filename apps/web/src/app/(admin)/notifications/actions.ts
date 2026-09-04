"use server";

import { markAllNotificationsRead, markNotificationRead } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const MarkOne = z.object({ notificationId: z.string().uuid() });

export async function markOneRead(formData: FormData): Promise<void> {
  // Server Actions accept direct POSTs: authorise here, and scope the write to
  // this user's own notifications inside the service.
  const session = await requireAdmin();
  const { notificationId } = MarkOne.parse({ notificationId: formData.get("notificationId") });
  await markNotificationRead(getDb(), session.organisationId, { userId: session.userId, notificationId });
  revalidatePath("/", "layout");
}

export async function markAllRead(): Promise<void> {
  const session = await requireAdmin();
  await markAllNotificationsRead(getDb(), session.organisationId, session.userId);
  revalidatePath("/", "layout");
}
