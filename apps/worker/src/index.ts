import { createDb, schema } from "@launchos/db";
import { setEnqueue } from "@launchos/core";
import { AnthropicLlmClient, FakeLlmClient, agentRegistry } from "@launchos/agents";
import { createIntegrations } from "@launchos/integrations";
import { env } from "./env.js";
import { QUEUE, createBoss } from "./boss.js";
import { runMonitorSweep } from "./jobs/monitor-check.js";
import { handleAgentRun, incidentPayload, type AgentRunJob } from "./jobs/agent-run.js";

async function main() {
  const db = createDb(env.DATABASE_URL);
  const boss = await createBoss(env.DATABASE_URL);
  const integrations = createIntegrations(process.env);
  const registry = agentRegistry(integrations);
  const llm = env.LLM === "fake" ? new FakeLlmClient([]) : new AnthropicLlmClient();

  setEnqueue(async (event) => {
    if (event.name === "incident.opened") {
      const payload = await incidentPayload(db, event.organisationId, event.incidentId);
      const job: AgentRunJob = { agentKey: "hosting-guard-dog", organisationId: event.organisationId, trigger: "event", payload };
      await boss.send(QUEUE.agentRun, job, { singletonKey: `guard-dog:${event.incidentId}` });
    }
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
  await boss.schedule(QUEUE.monitorCheck, "* * * * *", {}, { tz: "Europe/London" });
  console.info("worker started");
}
main().catch((e) => { console.error(e); process.exit(1); });
