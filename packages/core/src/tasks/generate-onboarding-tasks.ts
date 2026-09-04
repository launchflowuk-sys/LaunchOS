import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { TaskAssigneeRole } from "@launchos/db/schema";
import { and, eq } from "drizzle-orm";
import { recordActivity } from "../activity/record-activity.js";
import { listTaskTemplates } from "../packages/list-task-templates.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";
import { findOwnerUserId, pickLeastLoadedStaff } from "./assignee.js";
import { createTask } from "./create-task.js";
import { addDays } from "./dates.js";

/**
 * Postgres `unique_violation`: the row another run already created.
 * Drizzle wraps the driver's `PostgresError` in a `DrizzleQueryError`, so the
 * `23505` code can be on the error itself or one level down on `.cause`.
 */
function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === "23505" || errorCode((error as { cause?: unknown })?.cause) === "23505";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
}

/**
 * Turns a client's package into its onboarding task list.
 *
 * Idempotent by (client_id, template_id): running it again after the package
 * changed, or after a template was added, tops up what is missing and touches
 * nothing that already exists. The partial unique index on `tasks` backstops
 * the pre-filter if two runs race: a concurrent run's `createTask` may already
 * have taken a template between our pre-check and our insert, so a unique
 * violation there is treated as "already generated" and skipped rather than
 * aborting the whole batch.
 */
export async function generateOnboardingTasks(db: Db, organisationId: string, clientId: string) {
  await assertClientInOrganisation(db, organisationId, clientId);
  const [client] = await db.select().from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  if (!client) throw new Error(`client ${clientId} not found in organisation`);

  // With a package: that package's templates plus the global ones. Without a
  // package: global templates only — `includeGlobal: false` and no packageId
  // filters to `package_id IS NULL`.
  const templates = client.packageId
    ? await listTaskTemplates(db, organisationId, { phase: "onboarding", packageId: client.packageId, includeGlobal: true })
    : await listTaskTemplates(db, organisationId, { phase: "onboarding", includeGlobal: false });

  const existing = await db.select({ templateId: schema.tasks.templateId })
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.organisationId, organisationId),
      eq(schema.tasks.clientId, clientId),
      eq(schema.tasks.phase, "onboarding"),
    ));
  const alreadyGenerated = new Set(existing.map((r) => r.templateId).filter((v): v is string => v !== null));

  const pending = templates.filter((t) => !alreadyGenerated.has(t.id));
  const ownerUserId = pending.some((t) => t.defaultAssigneeRole === "owner") ? await findOwnerUserId(db, organisationId) : null;
  const staffUserId = pending.some((t) => t.defaultAssigneeRole === "staff") ? await pickLeastLoadedStaff(db, organisationId) : null;
  const assigneeFor = (role: TaskAssigneeRole) =>
    (role === "owner" ? ownerUserId : role === "staff" ? staffUserId : null) ?? undefined;

  const created: Awaited<ReturnType<typeof createTask>>[] = [];
  for (const template of pending) {
    try {
      created.push(await createTask(db, organisationId, {
        clientId,
        templateId: template.id,
        title: template.title,
        kind: template.kind,
        phase: "onboarding",
        descriptionMd: template.descriptionMd ?? undefined,
        dueAt: addDays(client.createdAt, template.offsetDays),
        assigneeUserId: assigneeFor(template.defaultAssigneeRole),
        checklist: template.checklist.map((label) => ({ label, done: false })),
        actorKind: "system",
      }));
    } catch (error) {
      // A concurrent run (another worker, a retried request) created this
      // template's task first — that is a successful outcome for us too.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  if (created.length > 0) {
    await recordActivity(db, organisationId, {
      clientId,
      actorKind: "system",
      kind: "tasks.onboarding_generated",
      title: `${created.length} onboarding task${created.length === 1 ? "" : "s"} generated`,
      link: `/clients/${clientId}/tasks`,
    });
  }

  return { created, skipped: templates.length - created.length };
}
