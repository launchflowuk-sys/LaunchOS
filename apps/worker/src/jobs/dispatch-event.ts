import type { DomainEvent } from "@launchos/core";
import type { Db } from "@launchos/db";
import type PgBoss from "pg-boss";
import { QUEUE } from "../boss.js";
import { incidentPayload, type AgentRunJob } from "./agent-run.js";
import type { GenerateOnboardingJob } from "./task-generation.js";

/** The only pg-boss surface this needs — narrow enough to fake in tests. */
export type BossSender = Pick<PgBoss, "send">;

export interface DispatchEventDeps { db: Db; boss: BossSender; }

/**
 * The single routing table from a domain event to a pg-boss job. Both entry
 * points funnel through here: events emitted inside the worker process, and
 * events the web process sends onto the `domain.event` queue (the web app
 * never picks a queue name itself). This is the only place `client.created`
 * maps to `tasks.generate-onboarding`, so a future consumer added to that
 * branch (e.g. Plan 4's `ensureEmailIdentity`) fires for every client
 * regardless of whether it was created from the web app or the worker.
 */
export async function dispatchEvent(deps: DispatchEventDeps, event: DomainEvent): Promise<void> {
  const { db, boss } = deps;
  if (event.name === "incident.opened") {
    const payload = await incidentPayload(db, event.organisationId, event.incidentId);
    const job: AgentRunJob = { agentKey: "hosting-guard-dog", organisationId: event.organisationId, trigger: "event", payload };
    await boss.send(QUEUE.agentRun, job, { singletonKey: `guard-dog:${event.incidentId}` });
    return;
  }
  if (event.name === "client.created") {
    const job: GenerateOnboardingJob = { organisationId: event.organisationId, clientId: event.clientId };
    await boss.send(QUEUE.tasksGenerateOnboarding, job, { singletonKey: `onboarding:${event.clientId}` });
    return;
  }
  // site.created / domain.created / member.created / task.created /
  // task.completed / task.overdue have no consumer yet; logged and ignored
  // on purpose.
  console.info({ event: event.name }, "domain event with no consumer");
}
