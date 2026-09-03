# @launchos/worker
Long-lived Node process. Boots pg-boss on DATABASE_URL, registers cron schedules and queue consumers (`monitor.check`, `agent.run`, `agent.resume`, `inbound.message`, `outbound.message`, `ads.ingest`), hosts the agent kernel.
Planned layout: `src/index.ts`, `src/boss.ts`, `src/jobs/<queue>.ts`, `src/cron.ts`.
