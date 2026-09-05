"use server";

import { clockIn, clockOut, startTimer, stopTimer } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { linkedLabel } from "./running";

/** Each admin module declares its own `ActionResult` with this shape. */
export type ActionResult = { status: "ok"; message?: string } | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * The top bar is in the admin layout, so a change to the running entry has
 * to reach every screen; the timesheet is where the entry lands.
 */
function revalidateClock(): void {
  revalidatePath("/", "layout");
  revalidatePath("/team/timesheets");
}

/** Server Actions accept direct POSTs, so every action re-authorises. Nobody clocks in for somebody else. */
export async function clockInAction(): Promise<ActionResult> {
  const session = await requireAdmin();
  try {
    const { started } = await clockIn(getDb(), session.organisationId, { userId: session.userId });
    revalidateClock();
    return { status: "ok", message: started ? "Clocked in" : "You were already clocked in" };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function clockOutAction(): Promise<ActionResult> {
  const session = await requireAdmin();
  try {
    const entry = await clockOut(getDb(), session.organisationId, { userId: session.userId });
    revalidateClock();
    return { status: "ok", message: entry ? "Clocked out" : "You were not clocked in" };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

const TimerTarget = z
  .object({ taskId: z.string().uuid().optional(), ticketId: z.string().uuid().optional() })
  .refine((v) => Boolean(v.taskId) !== Boolean(v.ticketId), { message: "A timer runs against a task or a case" });
export type TimerTarget = z.input<typeof TimerTarget>;

/**
 * Starts timing a task or a case. Whatever was running — a plain clock-in or
 * another timer — is closed first, and the result says what it was so the
 * button can say "stopped timing X" rather than silently swapping.
 */
export async function startTimerAction(input: TimerTarget): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = TimerTarget.safeParse(input);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid timer" };
  try {
    const { switchedFrom } = await startTimer(getDb(), session.organisationId, {
      userId: session.userId,
      ...parsed.data,
    });
    revalidateClock();
    if (parsed.data.taskId) revalidatePath(`/tasks/${parsed.data.taskId}`);
    if (parsed.data.ticketId) revalidatePath(`/cases/${parsed.data.ticketId}`);
    if (!switchedFrom) return { status: "ok", message: "Timer started" };
    const previous = await linkedLabel(session.organisationId, switchedFrom.taskId, switchedFrom.ticketId);
    return {
      status: "ok",
      message: previous ? `Timer started — stopped timing “${previous}”` : "Timer started — your clock-in was closed",
    };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function stopTimerAction(): Promise<ActionResult> {
  const session = await requireAdmin();
  try {
    const entry = await stopTimer(getDb(), session.organisationId, { userId: session.userId });
    revalidateClock();
    if (entry?.taskId) revalidatePath(`/tasks/${entry.taskId}`);
    if (entry?.ticketId) revalidatePath(`/cases/${entry.ticketId}`);
    return { status: "ok", message: entry ? "Timer stopped" : "Nothing was running" };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
