import { schema } from "@launchos/db";
import { z } from "zod";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * A date input carries no time. `17:00Z` is used so a task due "today" is not
 * already overdue at 00:01 on the dashboard's overdue count.
 */
export const DUE_TIME_SUFFIX = "T17:00:00.000Z";

export const CreateTaskSchema = z.object({
  clientId: z.string().uuid("Choose a client"),
  title: z.string().trim().min(1, "Title is required").max(200),
  phase: z.enum(schema.taskPhaseEnum.enumValues),
  kind: z.enum(schema.taskKindEnum.enumValues),
  priority: z.enum(schema.taskPriorityEnum.enumValues),
  dueAt: z.string().trim().max(10).optional(),
  assigneeUserId: z.string().trim().max(200).optional(),
  descriptionMd: z.string().trim().max(20000).optional(),
});

export const UpdateTaskStatusSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(schema.taskStatusEnum.enumValues),
});
