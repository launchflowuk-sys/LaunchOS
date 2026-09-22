/**
 * Reset the demo data from a terminal.
 *
 *   pnpm demo:seed -- --yes            # remove the old demo, write all three records
 *   pnpm demo:seed -- --remove --yes   # remove it and write nothing
 *   pnpm demo:seed -- --yes --org=launchflow
 *
 * Why this exists. The demo is a sales prop: it gets shown, clicked around,
 * and left in whatever state the last screenshare left it. Resetting it needs
 * to be one command rather than a throwaway test file, or it stops happening
 * and the demo drifts.
 *
 * **`--yes` is required, in every environment.** Not a host check — no host
 * string can tell a local database from a live one. `ssh -L` presents
 * production as `localhost`, this repository's own production compose file
 * names its database host `postgres`, and a Hetzner private network looks like
 * a LAN. Every one of those reads as local, so the only trustworthy guard is a
 * word the operator typed. `db:seed` reaches the same conclusion by a longer
 * route; see the note at the top of `packages/db/src/seed.ts`.
 *
 * Running it against production is the normal case, not the dangerous one:
 * the demo lives there so it can be shown from the real portal. What makes it
 * safe is that everything it writes is prefixed and everything it removes is
 * matched on that prefix — it cannot touch a real client, a real lead or a
 * real invoice, because it never selects anything that is not marked demo.
 */
import { createDb, schema } from "@launchos/db";
import { asc, eq } from "drizzle-orm";
import { removeDemoClients, seedDemoClients } from "./demo-client.js";
import { seedPortalShowcase } from "./portal-showcase.js";

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((value) => value === `--${name}` || value.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  const eq_ = hit.indexOf("=");
  return eq_ === -1 ? "" : hit.slice(eq_ + 1);
}

async function main(): Promise<void> {
  if (arg("yes") === undefined) {
    console.error(
      [
        "demo:seed refused — say --yes.",
        "",
        "  pnpm demo:seed -- --yes            reset the demo (three records)",
        "  pnpm demo:seed -- --remove --yes   remove it and write nothing",
        "",
        "Everything written is prefixed \"DEMO — \" and everything removed is matched",
        "on that prefix, so no real client, lead or invoice can be touched.",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("demo:seed refused — DATABASE_URL is not set.");
    process.exitCode = 1;
    return;
  }

  const db = createDb(url, { max: 2 });
  const slug = arg("org");

  // Named organisation, or the oldest one. The oldest is right for a
  // single-tenant install and wrong the moment there are two, so it is
  // printed rather than assumed.
  const rows = slug
    ? await db.select({ id: schema.organisations.id, name: schema.organisations.name, slug: schema.organisations.slug })
        .from(schema.organisations)
        .where(eq(schema.organisations.slug, slug))
    : await db.select({ id: schema.organisations.id, name: schema.organisations.name, slug: schema.organisations.slug })
        .from(schema.organisations)
        .orderBy(asc(schema.organisations.createdAt))
        .limit(1);

  const org = rows[0];
  if (!org) {
    console.error(slug ? `demo:seed refused — no organisation with slug "${slug}".` : "demo:seed refused — no organisations exist. Run pnpm db:bootstrap first.");
    process.exitCode = 1;
    return;
  }

  console.log(`organisation: ${org.name} (${org.slug})`);

  if (arg("remove") !== undefined) {
    const { removed } = await removeDemoClients(db, org.id);
    console.log(`removed ${removed} demo client${removed === 1 ? "" : "s"} and everything hanging off them.`);
    return;
  }

  const result = await seedDemoClients(db, org.id);
  // The portal record is separate from the three sales records: those show a
  // prospect the pipeline, this one gives the client portal six months of
  // history to be designed against.
  const portal = await seedPortalShowcase(db, org.id);
  console.log("");
  console.log(`  delivered  ${result.delivered.reference}  Riverside Dental Practice`);
  console.log(`  mid-build  ${result.inFlight.reference}  Thameside Garage`);
  console.log(`  open lead  ${result.openLead.reference}  Lumen Hair Studio`);
  console.log(`  portal     six months of history   Northgate Blinds`);
  console.log("");
  for (const [table, rowCount] of Object.entries({ ...result.created, ...portal.created }).sort()) {
    console.log(`  ${String(rowCount).padStart(3)}  ${table}`);
  }
}

try {
  await main();
} catch (error) {
  console.error("\ndemo:seed failed", error);
  process.exitCode = 1;
}
// The connection pool holds the event loop open; nothing else is pending.
process.exit(process.exitCode ?? 0);
