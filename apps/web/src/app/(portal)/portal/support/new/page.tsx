import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PortalForm } from "@/components/portal/portal-form";
import { requireClient } from "@/lib/portal-session";
import { createPortalTicket } from "../actions";
import { PORTAL_SEVERITIES } from "../schemas";

export const dynamic = "force-dynamic";

const CONTROL =
  "w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none";

export default async function NewPortalTicketPage() {
  // Nothing on this page is client-specific, but the gate still runs: an
  // unauthenticated visitor must never see the form at all.
  await requireClient();

  return (
    <>
      <PageHeader
        title="New request"
        description="Tell us what has happened and we will pick it up."
        actions={
          <Link href="/portal/support" className="text-sm text-neutral-600 hover:underline">
            Back to support
          </Link>
        }
      />

      <div className="max-w-2xl rounded-lg border border-neutral-200 bg-white p-6">
        <PortalForm action={createPortalTicket} submitLabel="Raise request" ariaLabel="New support request">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="subject" className="block text-sm font-medium text-neutral-700">
                Subject
              </label>
              <input id="subject" name="subject" required maxLength={200} className={`h-9 ${CONTROL}`} />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="severity" className="block text-sm font-medium text-neutral-700">
                Severity
              </label>
              {/* `critical` is deliberately absent — see PORTAL_SEVERITIES. */}
              <select id="severity" name="severity" defaultValue="medium" className={`h-9 ${CONTROL}`}>
                {PORTAL_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
              <p className="text-xs text-neutral-500">
                Pick &ldquo;high&rdquo; if something is down or losing you business.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="body" className="block text-sm font-medium text-neutral-700">
                What has happened?
              </label>
              <textarea id="body" name="body" required rows={6} maxLength={8000} className={`py-2 ${CONTROL}`} />
            </div>
          </div>
        </PortalForm>
      </div>
    </>
  );
}
