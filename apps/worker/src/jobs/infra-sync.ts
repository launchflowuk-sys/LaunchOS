import { syncInfrastructure } from "@launchos/core";
import type { Db } from "@launchos/db";

export interface InfraSyncDeps {
  db: Db;
  logger: Console;
  env?: NodeJS.ProcessEnv;
  sync?: typeof syncInfrastructure;
}

export interface InfraSyncJob {
  organisationId: string;
}

/** Every 15 minutes: Hetzner → servers + cost register. A failed connection is logged and shown on Settings, never thrown. */
export async function handleInfraSync(deps: InfraSyncDeps, job: InfraSyncJob) {
  const out = await (deps.sync ?? syncInfrastructure)(deps.db, job.organisationId, { ...(deps.env ? { env: deps.env } : {}) });
  for (const c of out.connections.filter((c) => !c.ok)) {
    deps.logger.warn("[infra.sync] connection failed", { organisationId: job.organisationId, label: c.label, error: c.error });
  }
  deps.logger.info("[infra.sync] done", { organisationId: job.organisationId, servers: out.servers });
  return out;
}
