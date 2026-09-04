import PgBoss from "pg-boss";

export const QUEUE = {
  monitorCheck: "monitor.check",
  agentRun: "agent.run",
  agentResume: "agent.resume",
  inboundMessage: "inbound.message",
  outboundMessage: "outbound.message",
  domainEvent: "domain.event",
  tasksGenerateOnboarding: "tasks.generate-onboarding",
  tasksGenerateRecurring: "tasks.generate-recurring",
  tasksCheckOverdue: "tasks.check-overdue",
  paymentsWebhook: "payments.webhook",
  adsIngest: "ads.ingest",
  adsSentinel: "ads.sentinel",
  invoicesOverdue: "invoices.check-overdue",
  reportsMonthly: "reports.monthly",
} as const;

export async function createBoss(connectionString: string) {
  const boss = new PgBoss({ connectionString, schema: "pgboss", retryLimit: 5, retryBackoff: true });
  boss.on("error", (e) => console.error("pg-boss error", e));
  await boss.start();
  for (const q of Object.values(QUEUE)) await boss.createQueue(q);
  return boss;
}
