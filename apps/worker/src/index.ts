import { createDb, schema } from "@launchos/db";
import { setEnqueue, type DomainEvent } from "@launchos/core";
import { AnthropicLlmClient, FakeLlmClient, agentRegistry } from "@launchos/agents";
import { createEmailAdapter } from "@launchos/channels";
import { createIntegrations } from "@launchos/integrations";
import { env } from "./env.js";
import { QUEUE, createBoss } from "./boss.js";
import { runMonitorSweep } from "./jobs/monitor-check.js";
import { handleAgentRun, type AgentRunJob } from "./jobs/agent-run.js";
import { handleAgentResume, type AgentResumeJob } from "./jobs/agent-resume.js";
import { handleInboundMessage, type InboundMessageJob } from "./jobs/inbound-message.js";
import { handleOutboundMessage, type OutboundMessageJob } from "./jobs/outbound-message.js";
import { handleGenerateOnboarding, runOverdueSweep, runRecurringSweep, type GenerateOnboardingJob } from "./jobs/task-generation.js";
import { dispatchEvent } from "./jobs/dispatch-event.js";

async function main() {
  const db = createDb(env.DATABASE_URL);
  const boss = await createBoss(env.DATABASE_URL);
  const integrations = createIntegrations(process.env);
  const llm = env.LLM === "fake" ? new FakeLlmClient([]) : new AnthropicLlmClient();
  const emailAdapter = createEmailAdapter(process.env);
  // The Ad Performance Sentinel emails clients a portal link once a human
  // approves the send, so the registry needs the same adapter and base URL the
  // web app serves the portal from.
  const registry = agentRegistry({
    integrations,
    email: emailAdapter,
    portalBaseUrl: process.env.APP_URL ?? "http://localhost:3000",
  });

  // One mapping for both entry points: events emitted inside the worker, and
  // events the web process sent through the domain.event queue. The routing
  // table itself lives in ./jobs/dispatch-event.ts so it can be unit tested
  // with a fake boss.
  const dispatch = (event: DomainEvent) => dispatchEvent({ db, boss }, event);

  setEnqueue(dispatch);

  await boss.work<DomainEvent>(QUEUE.domainEvent, async ([job]) => {
    await dispatch(job!.data);
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
  await boss.work<AgentResumeJob>(QUEUE.agentResume, async ([job]) => {
    const result = await handleAgentResume({ db, registry, llm, policy: env.AGENT_POLICY, logger: console }, job!.data);
    console.info({ result }, "agent resume");
  });
  await boss.work<InboundMessageJob>(QUEUE.inboundMessage, async ([job]) => {
    await handleInboundMessage({ db, logger: console }, job!.data);
  });
  await boss.work<OutboundMessageJob>(QUEUE.outboundMessage, async ([job]) => {
    await handleOutboundMessage({ db, adapter: emailAdapter, logger: console }, job!.data);
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
