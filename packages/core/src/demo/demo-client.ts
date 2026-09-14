import type { Db } from "@launchos/db";
import { seedOpenDemoLead, type DemoLeadResult } from "./open-lead.js";
import { seedDeliveredDemoClient } from "./riverside-dental.js";
import { type DemoClientResult, removeDemoClients } from "./shared.js";
import { seedInFlightDemoClient } from "./thameside-garage.js";

/**
 * The demo data, as one call.
 *
 * Three records rather than one, because a client can only be at one point in
 * the pipeline and the pipeline is the thing worth demonstrating:
 *
 * 1. **Riverside Dental** — delivered. The whole journey, past tense.
 * 2. **Thameside Garage** — mid-build. Phases running, an invoice overdue,
 *    content waiting on approval, site still building.
 * 3. **Lumen Hair Studio** — an open lead. Proposal sent, read, undecided.
 *    No client row, because nobody has accepted anything.
 *
 * Between them every screen has something on it in a state a prospect
 * recognises. One delivered client on its own leaves the in-progress half of
 * the software looking empty, and that is the half that sells it.
 *
 * Safe to run twice: it removes the previous demo first — all of it, found by
 * prefix rather than by parent — so re-running is how you reset the demo
 * rather than how you get a unique-constraint failure.
 */

export {
  DEMO_PREFIX,
  DEMO_PROPOSAL_PREFIX,
  DEMO_REFERENCE_PREFIX,
  DEMO_SLUG_PREFIX,
  removeDemoClients,
  type DemoClientResult,
} from "./shared.js";
export { seedDeliveredDemoClient } from "./riverside-dental.js";
export { seedInFlightDemoClient } from "./thameside-garage.js";
export { seedOpenDemoLead, type DemoLeadResult } from "./open-lead.js";

export interface DemoSeedResult {
  delivered: DemoClientResult;
  inFlight: DemoClientResult;
  openLead: DemoLeadResult;
  /** Every row written, summed across the three records. */
  created: Record<string, number>;
}

/**
 * Removes any previous demo and writes all three records.
 *
 * Sequential on purpose. They share a reference sequence and a slug prefix, so
 * running them concurrently would race the removal and each other for no
 * benefit — the whole thing takes well under a second either way.
 */
export async function seedDemoClients(
  db: Db,
  organisationId: string,
  now: Date = new Date(),
): Promise<DemoSeedResult> {
  await removeDemoClients(db, organisationId);

  const delivered = await seedDeliveredDemoClient(db, organisationId, now);
  const inFlight = await seedInFlightDemoClient(db, organisationId, now);
  const openLead = await seedOpenDemoLead(db, organisationId, now);

  const created: Record<string, number> = {};
  for (const part of [delivered.created, inFlight.created, openLead.created]) {
    for (const [key, value] of Object.entries(part)) {
      created[key] = (created[key] ?? 0) + value;
    }
  }

  return { delivered, inFlight, openLead, created };
}

/**
 * The single-client seeder, kept for anything that still calls it.
 *
 * It seeds **only** the delivered client, which is what it always did — after
 * removing every demo record, which is also what it always did. Prefer
 * `seedDemoClients`: one delivered client is not a demo of a pipeline.
 */
export async function seedDemoClient(
  db: Db,
  organisationId: string,
  now: Date = new Date(),
): Promise<DemoClientResult> {
  await removeDemoClients(db, organisationId);
  return seedDeliveredDemoClient(db, organisationId, now);
}

/** Removes every demo record. Named in the singular for its old callers. */
export async function removeDemoClient(db: Db, organisationId: string): Promise<{ removed: boolean }> {
  const { removed } = await removeDemoClients(db, organisationId);
  return { removed: removed > 0 };
}
