import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const SUPPORT_ASSIGNMENT_RULES = ["off", "round_robin", "least_open", "clocked_in_least_open"] as const;
export const TASK_ASSIGNMENT_RULES = ["off", "by_role_least_open"] as const;
export type SupportAssignmentRule = (typeof SUPPORT_ASSIGNMENT_RULES)[number];
export type TaskAssignmentRule = (typeof TASK_ASSIGNMENT_RULES)[number];

/** The Settings → Organisation "Assignment" section, as stored on `organisations.metadata.assignment`. */
export const AssignmentRules = z.object({
  support: z.enum(SUPPORT_ASSIGNMENT_RULES).default("off"),
  tasks: z.enum(TASK_ASSIGNMENT_RULES).default("off"),
});
export type AssignmentRules = z.infer<typeof AssignmentRules>;

export const DEFAULT_ASSIGNMENT_RULES: AssignmentRules = { support: "off", tasks: "off" };

export const SUPPORT_ASSIGNMENT_LABELS: Readonly<Record<SupportAssignmentRule, string>> = {
  off: "Off — cases stay unassigned until somebody picks them up",
  round_robin: "Round robin — each new case goes to the next person in turn",
  least_open: "Fewest open cases",
  clocked_in_least_open: "Fewest open cases among whoever is clocked in",
};

export const TASK_ASSIGNMENT_LABELS: Readonly<Record<TaskAssignmentRule, string>> = {
  off: "Off — the template's default assignee applies",
  by_role_least_open: "By the template's role, to whoever has the fewest open tasks",
};

/** Where the rules live inside `organisations.metadata`. */
export const ASSIGNMENT_METADATA_KEY = "assignment";

/** Reads what is stored, tolerating a missing or half-written object (every field has a default). */
export function assignmentRulesFrom(metadata: Record<string, unknown> | null | undefined): AssignmentRules {
  const raw = metadata?.[ASSIGNMENT_METADATA_KEY];
  const parsed = AssignmentRules.safeParse(typeof raw === "object" && raw !== null ? raw : {});
  return parsed.success ? parsed.data : DEFAULT_ASSIGNMENT_RULES;
}

export async function getAssignmentRules(db: Db, organisationId: string): Promise<AssignmentRules> {
  const [organisation] = await db
    .select({ metadata: schema.organisations.metadata })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  return assignmentRulesFrom(organisation?.metadata);
}

export const SetAssignmentRulesInput = z.object({
  // Not `AssignmentRules.partial()`: in Zod 4 an optional field keeps its
  // default, so an omitted rule would silently reset to "off".
  rules: z.object({
    support: z.enum(SUPPORT_ASSIGNMENT_RULES).optional(),
    tasks: z.enum(TASK_ASSIGNMENT_RULES).optional(),
  }),
  actorId: z.string().min(1),
});
export type SetAssignmentRulesInput = z.input<typeof SetAssignmentRulesInput>;

/**
 * Merges the given rules into `metadata.assignment`, leaving every other
 * metadata key (and the round-robin cursor) alone. Audited as
 * `organisation.assignment_updated`.
 */
export async function setAssignmentRules(db: Db, organisationId: string, input: SetAssignmentRulesInput): Promise<AssignmentRules> {
  const v = SetAssignmentRulesInput.parse(input);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const before = await getAssignmentRules(tx, organisationId);
    const after: AssignmentRules = {
      support: v.rules.support ?? before.support,
      tasks: v.rules.tasks ?? before.tasks,
    };
    const patch = { [ASSIGNMENT_METADATA_KEY]: after };
    const [row] = await tx
      .update(schema.organisations)
      .set({
        metadata: sql`coalesce(${schema.organisations.metadata}, '{}'::jsonb)
          || jsonb_build_object(${ASSIGNMENT_METADATA_KEY}::text, coalesce(${schema.organisations.metadata}->${ASSIGNMENT_METADATA_KEY}, '{}'::jsonb) || ${JSON.stringify(after)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(schema.organisations.id, organisationId))
      .returning({ id: schema.organisations.id });
    if (!row) throw new Error(`organisation ${organisationId} not found`);
    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "organisation.assignment_updated",
      targetType: "organisation", targetId: organisationId, before, after: patch[ASSIGNMENT_METADATA_KEY],
    });
    return after;
  });
}

/** True when new cases are routed automatically. */
export async function supportAssignmentOn(db: Db, organisationId: string): Promise<boolean> {
  return (await getAssignmentRules(db, organisationId)).support !== "off";
}

/** True when generated tasks are routed automatically. */
export async function taskAssignmentOn(db: Db, organisationId: string): Promise<boolean> {
  return (await getAssignmentRules(db, organisationId)).tasks !== "off";
}
