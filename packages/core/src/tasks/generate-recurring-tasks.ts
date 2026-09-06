import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PackageIncludes, TaskAssigneeRole, TaskKind, TaskRecurrence } from "@launchos/db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { getPackage } from "../packages/list-packages.js";
import { listTaskTemplates } from "../packages/list-task-templates.js";
import { autoAssignTask, taskAssignmentOn } from "../assignment/auto-assign.js";
import { findOwnerUserId, pickLeastLoadedStaff } from "./assignee.js";
import { createTask } from "./create-task.js";
import { dueWithinPeriod, periodBounds } from "./dates.js";
import { evidenceFromTemplate } from "./evidence.js";

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
 * How many of this template to create for the current period. Monthly
 * quantities come from the package; anything else is one per period. An SEO
 * template on a package without SEO produces nothing.
 */
export function quantityFor(kind: TaskKind, recurrence: TaskRecurrence, includes: PackageIncludes): number {
  if (kind === "seo" && !includes.seo) return 0;
  if (recurrence !== "monthly") return 1;
  if (kind === "social") return includes.socialPostsPerMonth;
  if (kind === "content") return includes.blogPostsPerMonth;
  if (kind === "gbp") return includes.gbpUpdatesPerMonth;
  return 1;
}

export const GenerateRecurringTasksInput = z.object({ now: z.coerce.date().default(() => new Date()) });
export type GenerateRecurringTasksInput = z.input<typeof GenerateRecurringTasksInput>;

/**
 * The daily 06:00 sweep. Every active client on an active package gets the
 * period's service work created once. Idempotency is the (client_id,
 * recurrence_key) unique index; the pre-check keeps the common re-run cheap
 * and the index turns a genuine race into a skip rather than a duplicate.
 *
 * Each client is isolated: a real failure for one client (as opposed to a
 * unique-violation race, which is absorbed below) is collected rather than
 * thrown immediately, so every other client still gets its sweep this run.
 * If any client failed, the failures are rethrown together — after all
 * clients have been attempted — as an `AggregateError`.
 */
export async function generateRecurringTasks(db: Db, organisationId: string, input: GenerateRecurringTasksInput = {}) {
  const { now } = GenerateRecurringTasksInput.parse(input);
  const clients = await db.select().from(schema.clients).where(and(
    eq(schema.clients.organisationId, organisationId),
    eq(schema.clients.status, "active"),
    isNotNull(schema.clients.packageId),
  )).orderBy(asc(schema.clients.createdAt));

  let created = 0;
  let skipped = 0;
  const failures: { clientId: string; error: unknown }[] = [];
  // See generateOnboardingTasks: with the rule on, `autoAssignTask` routes
  // every new task and the template defaults are not consulted.
  const autoAssign = await taskAssignmentOn(db, organisationId);

  for (const client of clients) {
    try {
      const pkg = await getPackage(db, organisationId, client.packageId!);
      if (!pkg || !pkg.active) continue;

      const templates = (await listTaskTemplates(db, organisationId, {
        phase: "recurring", packageId: pkg.id, includeGlobal: true,
      })).filter((t) => t.recurrence !== "none");

      for (const template of templates) {
        const quantity = quantityFor(template.kind, template.recurrence, pkg.includes);
        if (quantity < 1) continue;
        const period = periodBounds(template.recurrence, now);

        for (let n = 1; n <= quantity; n += 1) {
          const recurrenceKey = `${template.kind}:${period.key}:${n}`;
          const [existing] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
            eq(schema.tasks.clientId, client.id),
            eq(schema.tasks.recurrenceKey, recurrenceKey),
          ));
          if (existing) { skipped += 1; continue; }

          try {
            const task = await createTask(db, organisationId, {
              clientId: client.id,
              templateId: template.id,
              title: quantity > 1 ? `${template.title} ${n}/${quantity}` : template.title,
              kind: template.kind,
              phase: "recurring",
              descriptionMd: template.descriptionMd ?? undefined,
              dueAt: dueWithinPeriod(period, n, quantity),
              assigneeUserId: autoAssign ? undefined : await assigneeFor(db, organisationId, template.defaultAssigneeRole),
              checklist: template.checklist.map((label) => ({ label, done: false })),
              evidence: evidenceFromTemplate(template),
              recurrenceKey,
              actorKind: "system",
            });
            created += 1;
            if (autoAssign) await autoAssignTask(db, organisationId, { taskId: task.id, role: template.defaultAssigneeRole });
          } catch (error) {
            // A concurrent run already claimed this (client, recurrence_key)
            // slot — that is a successful outcome for us too.
            if (!isUniqueViolation(error)) throw error;
            skipped += 1;
          }
        }
      }
    } catch (error) {
      // Do not let one client's real failure stop the sweep for the rest.
      failures.push({ clientId: client.id, error });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `generateRecurringTasks failed for ${failures.length} of ${clients.length} client(s): ${failures.map((f) => f.clientId).join(", ")}`,
    );
  }

  return { created, skipped };
}

async function assigneeFor(db: Db, organisationId: string, role: TaskAssigneeRole): Promise<string | undefined> {
  if (role === "owner") return (await findOwnerUserId(db, organisationId)) ?? undefined;
  if (role === "staff") return (await pickLeastLoadedStaff(db, organisationId)) ?? undefined;
  return undefined;
}
