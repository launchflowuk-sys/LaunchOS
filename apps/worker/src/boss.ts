import PgBoss from "pg-boss";

export const QUEUE = { monitorCheck: "monitor.check", agentRun: "agent.run" } as const;

export async function createBoss(connectionString: string) {
  const boss = new PgBoss({ connectionString, schema: "pgboss", retryLimit: 5, retryBackoff: true });
  boss.on("error", (e) => console.error("pg-boss error", e));
  await boss.start();
  for (const q of Object.values(QUEUE)) await boss.createQueue(q);
  return boss;
}
