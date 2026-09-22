import { demoDataSummary } from "@launchos/core";
import { forbidden } from "next/navigation";
import { KeyValue } from "@/components/key-value";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { DemoControls } from "./demo-controls";

export const dynamic = "force-dynamic";

/**
 * Demo data, written and removed from here rather than a terminal.
 *
 * The CLI needs a `DATABASE_URL` for whichever database you mean, which is
 * right on a laptop and wrong for production — it means holding the production
 * credential in a shell to press a button. This does it in the app, against
 * the database it is already connected to.
 *
 * Four records: three that show a prospect the pipeline, and one client with
 * six months of history so the client portal has something on every panel.
 * Everything is prefixed `DEMO — ` and slugged `demo-`, so removal finds all
 * of it and nothing real can be caught by it.
 */
export default async function DemoDataSettingsPage() {
  const gate = await requirePermission("settings");
  if (!gate.ok) forbidden();

  const summary = await demoDataSummary(getDb(), gate.session.organisationId);
  const present = summary.clients.length > 0;
  const { rows } = summary;

  return (
    <>
      <PageHeader
        title="Demo data"
        description="Realistic clients for showing the software and testing screens against. Never mixed with real records."
        category="organisation"
      />

      <Section
        title={present ? "Currently in this account" : "Nothing written yet"}
        description={
          present
            ? "Everything below is demo data. Removing it takes the clients and every record hanging off them."
            : "Write it to fill the admin and the client portal with a realistic account you can click through."
        }
      >
        <div className="rounded-[20px] border bg-card p-5">
          {present ? (
            <>
              <KeyValue
                items={[
                  { label: "Demo clients", value: summary.clients.join(", ") },
                  { label: "Support cases", value: String(rows.tickets) },
                  { label: "Tasks", value: String(rows.tasks) },
                  { label: "Invoices", value: String(rows.invoices) },
                  { label: "Monthly reports", value: String(rows.reports) },
                  { label: "Uptime checks", value: rows.uptimeChecks.toLocaleString("en-GB") },
                ]}
              />
              <div className="mt-5 border-t pt-5">
                <DemoControls present />
              </div>
            </>
          ) : (
            <>
              <p className="text-row text-muted-foreground">
                Four clients: a delivered build, one mid-build, an open lead, and one with six months of
                history — uptime checks, support cases, invoices and monthly reports — so the client
                portal has something on every panel.
              </p>
              <div className="mt-5">
                <DemoControls present={false} />
              </div>
            </>
          )}
        </div>
      </Section>

      <Section title="What it does not touch">
        <div className="rounded-[20px] border bg-card p-5">
          <p className="text-row text-muted-foreground">
            Demo clients are named <code className="rounded bg-muted px-1.5 py-0.5 text-sm">DEMO — …</code> and
            slugged <code className="rounded bg-muted px-1.5 py-0.5 text-sm">demo-</code>, and removal matches on
            exactly that. A real client cannot be caught by it, whatever it is called.
          </p>
          <p className="mt-3 text-row text-muted-foreground">
            Writing it removes any previous demo first, so pressing the button twice leaves one copy rather
            than two.
          </p>
        </div>
      </Section>
    </>
  );
}
