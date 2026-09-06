import { createDb } from "@launchos/db";
import { setEnqueue, type DomainEvent } from "@launchos/core";
import { AnthropicLlmClient, agentRegistry, scopedCmsProvider } from "@launchos/agents";
import { createEmailAdapter, createPushAdapterFromEnv } from "@launchos/channels";
import { createIntegrations, describeAdapters } from "@launchos/integrations";
import { loadEnv } from "./env.js";
import { FakeAgentLlmClient } from "./llm/fake.js";
import { QUEUE, createBoss } from "./boss.js";
import { installProcessErrorAlerts, reportJobFailure } from "./error-alerts.js";
import { startHealthServer } from "./health.js";
import { startHeartbeat } from "./heartbeat.js";
import { installPdfShutdown, pdfRendererName } from "./pdf.js";
import { WorkerTelemetry, instrumentBoss } from "./telemetry.js";
import { handlePushSend, type PushSendJob } from "./jobs/push-send.js";
import { SLA_SWEEP_CRON, runSlaSweep } from "./jobs/sla-sweep.js";
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
import { STRIPE_RECONCILE_CRON, runStripeReconcile } from "./jobs/stripe-reconcile.js";
import { runMonthlyReports } from "./jobs/reports-monthly.js";
import { runResumeSweep, runStuckRunSweep } from "./jobs/resume-sweep.js";
import { runOutboundSweep } from "./jobs/outbound-sweep.js";
import { ensureContentWriterEnabled } from "./jobs/content-enablement.js";
import { registerContentJobs } from "./jobs/content-jobs.js";
import { ensureOpsBriefEnabled, registerOpsBriefJob } from "./jobs/ops-brief.js";
import { ensureLeadQualifierEnabled } from "./jobs/lead-enablement.js";
import { registerMeetingJobs } from "./jobs/meetings-jobs.js";
import { ensureProposalDrafterEnabled, registerProposalJobs } from "./jobs/proposals-jobs.js";

async function main() {
  // First thing, and before a single connection is opened: a worker with no
  // Anthropic key on the default LLM, or the fake client in production, must
  // fail here with a message naming the variable rather than a hundred failed
  // agent runs later.
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  // The worker watching itself, from the first line: an uncaught error is an
  // owner alert, not a silent restart; the health endpoint answers 503 until
  // every handler below is registered; the heartbeat row is what the admin
  // layout's "worker down" banner reads.
  installProcessErrorAlerts({ db, logger: console });
  // The document engine's browser is process-wide and lazily launched; this is
  // the only thing that closes it, and without it a redeploy waits for the
  // SIGKILL rather than stopping (see ./pdf.ts).
  installPdfShutdown({ logger: console });
  const telemetry = new WorkerTelemetry();
  let ready = false;
  const health = await startHealthServer({ port: env.WORKER_HEALTH_PORT, status: () => ({ ready, ...telemetry.snapshot() }) });
  const boss = instrumentBoss(await createBoss(env.DATABASE_URL), {
    telemetry,
    logger: console,
    onFinalFailure: (failure) => reportJobFailure({ db, logger: console }, failure),
  });
  const integrations = createIntegrations(process.env);
  const llm = env.LLM === "fake" ? new FakeAgentLlmClient() : AnthropicLlmClient.fromEnv(env);
  const emailAdapter = createEmailAdapter(process.env);
  const pushAdapter = createPushAdapterFromEnv(process.env);
  // The Ad Performance Sentinel emails clients a portal link once a human
  // approves the send, so the registry needs the same adapter and base URL the
  // web app serves the portal from.
  //
  // The CMS is the one adapter this process cannot build once at startup: the
  // real WordPress provider reads each site's credentials through a resolver
  // bound to one organisation, and this registry serves every organisation.
  // `scopedCmsProvider` builds it per run, from the run's own organisation, so
  // an approved content change can only reach a site that tenant owns. With
  // `SECRETS_ENCRYPTION_KEY` unset it is the same mock `integrations.cms` is.
  const registry = agentRegistry({
    integrations: { ...integrations, cms: scopedCmsProvider(process.env) },
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
    const result = await handlePaymentsWebhook(db, job!.data, { payments: integrations.payments });
    console.info({ event: job!.data.providerEvent.type, ...result }, "payments webhook");
  });

  // The nightly Stripe reconcile: the owner's stored product selection
  // re-applied — a new subscription on a linked package becomes a client,
  // a status change reaches the owner's bell. Skipped on the mock adapter.
  await boss.work(QUEUE.billingStripeReconcile, async () => {
    await sweepOrganisations(db, "stripe reconcile", async (organisationId) => {
      await runStripeReconcile(db, organisationId, integrations.payments, console);
    });
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

  // Alerts that reach the phone: one job per urgent notification, fanned out
  // to the user's subscribed devices. A dead endpoint is removed, a failing
  // one stamped; the job never throws for either, so a phone that did get
  // the alert is not rung twice by a retry.
  await boss.work<PushSendJob>(QUEUE.pushSend, async ([job]) => {
    await handlePushSend({ db, push: pushAdapter, env: process.env, logger: console }, job!.data);
  });

  // The first-response SLA: every fifteen minutes, any client-visible case
  // still unanswered after the promised hours rings the owner and the
  // assignee, once per case.
  await boss.work(QUEUE.supportSlaSweep, async () => {
    console.info(await runSlaSweep(db, new Date()), "support SLA sweep");
  });

  // The content engine: plan the month, draft it, publish what is approved
  // when it is due, report on it. Its workers and crons register together in
  // ./jobs/content-jobs.ts so a test can assert the schedule; the writer is
  // switched on by default for every organisation that has never decided
  // about it (an existing row, on or off, is left alone).
  await ensureContentWriterEnabled(db);
  await registerContentJobs({
    db,
    boss,
    agentRun: { db, registry, llm, policy: env.AGENT_POLICY, logger: console },
    social: integrations.social,
    cms: scopedCmsProvider(process.env),
    imagegen: integrations.imagegen,
  });

  // The morning Ops Brief: one agent run per organisation at 07:00 London,
  // then the owner's bell and, with OWNER_NOTIFY_EMAIL set, the branded email.
  // On by default like the writer; a person's decision in Settings → Agents
  // is never overwritten.
  await ensureOpsBriefEnabled(db);
  await registerOpsBriefJob({
    db,
    boss,
    agentRun: { db, registry, llm, policy: env.AGENT_POLICY, logger: console },
    email: emailAdapter,
    env: process.env,
  });

  // The Lead Qualifier drafts a first reply to every enquiry that arrives on
  // its own (dispatch-event routes `lead.created`); on by default like the
  // writer, gated by the `lead_reply` approval card. The meeting crons send
  // the guest's reminders and the host's 15-minute alert, then the morning
  // follow-ups.
  await ensureLeadQualifierEnabled(db);
  await registerMeetingJobs({ db, boss, env: process.env });

  // Proposals: the send path (the only process with a browser to render one),
  // the follow-on a client's acceptance hands over, and the two daily sweeps.
  // `registerProposalJobs` also installs `setProposalFollowOn`, which is what
  // turns `acceptProposal`'s no-op hook into a real queue send.
  await ensureProposalDrafterEnabled(db);
  await registerProposalJobs({ db, boss, payments: integrations.payments, env: process.env });

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
  await boss.schedule(QUEUE.supportSlaSweep, SLA_SWEEP_CRON, {}, { tz: "Europe/London" });
  await boss.schedule(QUEUE.billingStripeReconcile, STRIPE_RECONCILE_CRON, {}, { tz: "Europe/London" });

  // Everything is registered: the health endpoint may say so, and the first
  // heartbeat clears the admin banner at once rather than a minute from now.
  ready = true;
  const heartbeat = startHeartbeat({
    db, snapshot: () => telemetry.snapshot(), details: { pid: process.pid, healthPort: health.port }, logger: console,
  });
  await heartbeat.beat();
  // Which brain is in the box and which adapters are wired, in the first line of
  // the log. `LLM=fake`, or an `EMAIL_ADAPTER` lost in a redeploy, is otherwise
  // invisible until an agent answers from a stub or a week of replies turns out
  // never to have left. Names only — no hosts, keys or addresses.
  console.info(
    {
      llm: env.LLM,
      model: env.LLM === "fake" ? "fake-agent-llm" : env.AGENT_MODEL,
      policy: env.AGENT_POLICY,
      adapters: describeAdapters(process.env),
      pdf: pdfRendererName(process.env),
      healthPort: health.port,
    },
    "worker started",
  );
}
main().catch((e) => { console.error(e); process.exit(1); });
