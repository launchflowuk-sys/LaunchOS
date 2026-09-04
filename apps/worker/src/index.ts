import { createDb } from "@launchos/db";
import { setEnqueue, type DomainEvent } from "@launchos/core";
import { AnthropicLlmClient, agentRegistry } from "@launchos/agents";
import { createEmailAdapter } from "@launchos/channels";
import { createIntegrations } from "@launchos/integrations";
import { loadEnv } from "./env.js";
import { FakeAgentLlmClient } from "./llm/fake.js";
import { QUEUE, createBoss } from "./boss.js";
import { sweepOrganisations } from "./jobs/sweep-organisations.js";
import { runMonitorSweep } from "./jobs/monitor-check.js";
import { handleAgentRun, type AgentRunJob } from "./jobs/agent-run.js";
import { handleAgentResume, type AgentResumeJob } from "./jobs/agent-resume.js";
import { handleInboundMessage, type InboundMessageJob } from "./jobs/inbound-message.js";
import { handleOutboundMessage, type OutboundMessageJob } from "./jobs/outbound-message.js";
import { handleGenerateOnboarding, runOverdueSweep, runRecurringSweep, type GenerateOnboardingJob } from "./jobs/task-generation.js";
import { dispatchEvent } from "./jobs/dispatch-event.js";
import { handlePaymentsWebhook, type PaymentsWebhookJob } from "./jobs/payments-webhook.js";
import { runAdsIngest } from "./jobs/ads-ingest.js";
import { dispatchSentinelRuns } from "./jobs/ads-sentinel.js";
import { runOverdueSweep as runInvoiceOverdueSweep } from "./jobs/invoices-overdue.js";
import { runMonthlyReports } from "./jobs/reports-monthly.js";
import { runResumeSweep, runStuckRunSweep } from "./jobs/resume-sweep.js";
import { runOutboundSweep } from "./jobs/outbound-sweep.js";

async function main() {
  // First thing, and before a single connection is opened: a worker with no
  // Anthropic key on the default LLM, or the fake client in production, must
  // fail here with a message naming the variable rather than a hundred failed
  // agent runs later.
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const boss = await createBoss(env.DATABASE_URL);
  const integrations = createIntegrations(process.env);
  const llm = env.LLM === "fake" ? new FakeAgentLlmClient() : new AnthropicLlmClient();
  const emailAdapter = createEmailAdapter(process.env);
  // The Ad Performance Sentinel emails clients a portal link once a human
  // approves the send, so the registry needs the same adapter and base URL the
  // web app serves the portal from.
  const registry = agentRegistry({
    integrations,
    email: emailAdapter,
    portalBaseUrl: env.APP_URL,
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
    await sweepOrganisations(db, "monitor sweep", async (organisationId) => {
      const r = await runMonitorSweep(db, organisationId, integrations.uptime);
      console.info({ org: organisationId, ...r }, "monitor sweep");
    });
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

  await boss.work<PaymentsWebhookJob>(QUEUE.paymentsWebhook, async ([job]) => {
    const result = await handlePaymentsWebhook(db, job!.data);
    console.info({ event: job!.data.providerEvent.type, ...result }, "payments webhook");
  });

  await boss.work(QUEUE.adsIngest, async () => {
    const now = new Date();
    await sweepOrganisations(db, "ads ingest", async (organisationId) => {
      console.info(await runAdsIngest(db, organisationId, integrations.ads, { now }), "ads ingest");
    });
  });

  await boss.work(QUEUE.invoicesOverdue, async () => {
    const now = new Date();
    await sweepOrganisations(db, "overdue invoice sweep", async (organisationId) => {
      console.info(await runInvoiceOverdueSweep(db, organisationId, { now }), "overdue invoice sweep");
    });
  });

  await boss.work(QUEUE.reportsMonthly, async () => {
    const now = new Date();
    await sweepOrganisations(db, "monthly reports", async (organisationId) => {
      console.info(await runMonthlyReports(db, organisationId, { now }), "monthly reports");
    });
  });

  // Delivery insurance for a decision the web request could not enqueue, and
  // the closer for a run whose delivery died. Neither undoes anything: a
  // decision is final once `decideApproval` commits, so what is repaired here
  // is the *delivery*, not the decision.
  await boss.work(QUEUE.approvalsResumeSweep, async () => {
    const now = new Date();
    await sweepOrganisations(db, "approval resume sweep", async (organisationId) => {
      await runResumeSweep({ db, boss }, organisationId, now);
    });
  });

  // The same insurance for outbound mail. `replyToConversation` commits the
  // `queued` row and the web request then enqueues `outbound.message`; if that
  // send is lost, the reply sits on the thread for ever with nothing to send it.
  await boss.work(QUEUE.outboundSweep, async () => {
    const now = new Date();
    await sweepOrganisations(db, "outbound message sweep", async (organisationId) => {
      await runOutboundSweep({ db, boss }, organisationId, now);
    });
  });

  await boss.work(QUEUE.agentRunsStuckSweep, async () => {
    const now = new Date();
    await sweepOrganisations(db, "stranded agent run sweep", async (organisationId) => {
      await runStuckRunSweep({ db }, organisationId, now);
    });
  });

  await boss.work(QUEUE.adsSentinel, async () => {
    await dispatchSentinelRuns({ db, boss }, new Date());
  });

  await boss.schedule(QUEUE.monitorCheck, "* * * * *", {}, { tz: "Europe/London" });
  // Every minute: a decided approval whose resume never arrived is an approved
  // outward action that is not happening, and nothing else revisits it.
  await boss.schedule(QUEUE.approvalsResumeSweep, "* * * * *", {}, { tz: "Europe/London" });
  // Every minute, for the same reason: a `queued` message nothing is driving is
  // a reply the client never receives, and only this notices.
  await boss.schedule(QUEUE.outboundSweep, "* * * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.agentRunsStuckSweep, "*/10 * * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.tasksGenerateRecurring, "0 6 * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.tasksCheckOverdue, "0 8 * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.adsIngest, "30 6 * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.adsSentinel, "0 7 * * *", {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.invoicesOverdue, "30 7 * * *", {}, { tz: "Europe/London" });
  // After ads.ingest (06:30) has landed the final day of the month's metrics
  // and after invoices.check-overdue (07:30), so the drafted report reports a
  // full month of ad spend and current invoice statuses.
  await boss.schedule(QUEUE.reportsMonthly, "45 7 1 * *", {}, { tz: "Europe/London" });
  // Which brain is in the box, in the first line of the log. `LLM=fake` in a
  // deployment that meant to use Anthropic is otherwise invisible until an
  // agent answers from a scripted stub.
  console.info(
    { llm: env.LLM, model: env.LLM === "fake" ? "fake-agent-llm" : env.AGENT_MODEL, policy: env.AGENT_POLICY },
    "worker started",
  );
}
main().catch((e) => { console.error(e); process.exit(1); });
