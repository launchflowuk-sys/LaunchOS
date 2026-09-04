"use server";

import { assignTask, createTask, updateTaskStatus } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { type ActionResult, CreateTaskSchema, DUE_TIME_SUFFIX, UpdateTaskStatusSchema } from "./schemas";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** Server Actions accept direct POSTs, so every action re-authorises and re-validates. */
export async function createTaskAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = CreateTaskSchema.safeParse({
    clientId: value(formData, "clientId"),
    title: value(formData, "title"),
    phase: value(formData, "phase"),
    kind: value(formData, "kind"),
    priority: value(formData, "priority"),
    dueAt: value(formData, "dueAt"),
    assigneeUserId: value(formData, "assigneeUserId"),
    descriptionMd: value(formData, "descriptionMd"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid task" };
  const v = parsed.data;

  try {
    const task = await createTask(getDb(), session.organisationId, {
      clientId: v.clientId,
      title: v.title,
      phase: v.phase,
      kind: v.kind,
      priority: v.priority,
      ...(v.dueAt ? { dueAt: new Date(`${v.dueAt}${DUE_TIME_SUFFIX}`) } : {}),
      ...(v.descriptionMd ? { descriptionMd: v.descriptionMd } : {}),
      actorKind: "user",
      actorId: session.userId,
    });

    // Assignment goes through assignTask rather than createTask: it is the one
    // path that checks org membership, audits the assignment on its own and
    // notifies the new owner.
    if (v.assigneeUserId) {
      await assignTask(getDb(), session.organisationId, {
        taskId: task.id,
        assigneeUserId: v.assigneeUserId,
        actorKind: "user",
        actorId: session.userId,
      });
    }

    revalidatePath("/tasks");
    revalidatePath("/");
    return { status: "ok", id: task.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function updateTaskStatusAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = UpdateTaskStatusSchema.safeParse({
    taskId: value(formData, "taskId"),
    status: value(formData, "status"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid status" };
  const v = parsed.data;

  try {
    const { task } = await updateTaskStatus(getDb(), session.organisationId, {
      taskId: v.taskId,
      status: v.status,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath("/tasks");
    revalidatePath(`/tasks/${v.taskId}`);
    revalidatePath(`/clients/${task.clientId}`);
    revalidatePath("/");
    return { status: "ok", id: task.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
