import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import { openIncident, recordCheck, updateIncident } from "@launchos/core";
import type { UptimeProbe } from "@launchos/integrations";

export async function runMonitorSweep(db: Db, organisationId: string, probe: UptimeProbe) {
  const monitors = await db.select().from(schema.monitors)
    .where(and(eq(schema.monitors.organisationId, organisationId), eq(schema.monitors.enabled, true), isNull(schema.monitors.deletedAt)));
  let incidentsOpened = 0, incidentsResolved = 0;
  for (const m of monitors) {
    const probeResult = await probe.check(m.target);
    const outcome = await recordCheck(db, organisationId, { monitorId: m.id, ...probeResult });
    if (outcome.shouldOpenIncident) {
      await openIncident(db, organisationId, { siteId: m.siteId, monitorId: m.id, title: `${m.target} is down`, severity: "critical" });
      incidentsOpened += 1;
    }
    if (outcome.shouldResolveIncident) {
      const open = await db.select({ id: schema.incidents.id }).from(schema.incidents)
        .where(and(eq(schema.incidents.organisationId, organisationId), eq(schema.incidents.monitorId, m.id), ne(schema.incidents.status, "resolved")));
      for (const inc of open) { await updateIncident(db, organisationId, { incidentId: inc.id, status: "resolved" }); incidentsResolved += 1; }
    }
  }
  return { checked: monitors.length, incidentsOpened, incidentsResolved };
}
