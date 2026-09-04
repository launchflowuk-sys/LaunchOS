import { createDb, schema } from "@launchos/db";
import { setEnqueue, type DomainEvent } from "@launchos/core";
import { AnthropicLlmClient, FakeLlmClient, agentRegistry } from "@launchos/agents";
import { createIntegrations } from "@launchos/integrations";
import { env } from "./env.js";
import { QUEUE, createBoss } from "./boss.js";
import { runMonitorSweep } from "./jobs/monitor-check.js";
import { handleAgentRun, incidentPayload, type AgentRunJob } from "./jobs/agent-run.js";
import { handleGenerateOnboarding, runOverdueSweep, runRecurringSweep, type GenerateOnboardingJob } from "./jobs/task-generation.js";

async function main() {
  const db = createDb(env.DATABASE_URL);
  const boss = await createBoss(env.DATABASE_URL);
  const integrations = createIntegrations(process.env);
  const registry = agentRegistry(integrations);
  const llm = env.LLM === "fake" ? new FakeLlmClient([]) : new AnthropicLlmClient();

  // One mapping for both entry points: events emitted inside the worker, and
  // events the web process sent through the domain.event queue.
  async function dispatchEvent(event: DomainEvent) {
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

  setEnqueue(dispatchEvent);

  await boss.work<DomainEvent>(QUEUE.domainEvent, async ([job]) => {
    await dispatchEvent(job!.data);
  });

  await boss.work(QUEUE.monitorCheck, async () => {
    const orgs = await db.select({ id: schema.organisations.id }).from(schema.organisations);
    for (const org of orgs) {
      const r = await runMonitorSweep(db, org.id, integrations.uptime);
      console.info({ org: org.id, ...r }, "monitor sweep");
    }
  });
  await boss.work<AgentRunJob>(QUEUE.agentRun, async ([job]) => {
    const result = await handleAgentRun({ db, registry, llm, policy: env.AGENT_POLICY, logger: console }, job!.data);
    console.info({ result }, "agent run");
  });
  await boss.work<GenerateOnboardingJob>(QUEUE.tasksGenerateOnboarding, async ([job]) => {
    const result = await handleGenerateOnboarding(db, job!.data);
    console.info({ client: job!.data.clientId, ...result }, "onboarding tasks generated");
  });
  await boss.work(QUEUE.tasksGenerateRecurring, async () => {
    console.info(await runRecurringSweep(db, new Date()), "recurring task sweep");
  });
  await boss.work(QUEUE.tasksCheckOverdue, async () => {
    console.info(await runOverdueSweep(db, new Date()), "overdue task sweep");
  });
  await boss.schedule(QUEUE.monitorCheck, "* * * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.tasksGenerateRecurring, "0 6 * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.tasksCheckOverdue, "0 8 * * *", {}, { tz: "Europe/London" });
  console.info("worker started");
}
main().catch((e) => { console.error(e); process.exit(1); });
