import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PortalForm } from "@/components/portal/portal-form";
import { PortalSelect } from "@/components/portal/portal-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { requireClient } from "@/lib/portal-session";
import { createPortalTicket } from "../actions";
import { PORTAL_SEVERITIES } from "../schemas";

export const dynamic = "force-dynamic";

/** Plain words for the three severities a client is allowed to pick. */
const SEVERITY_LABEL: Record<(typeof PORTAL_SEVERITIES)[number], string> = {
  low: "Low — whenever you can get to it",
  medium: "Medium — it needs sorting soon",
  high: "High — something is down or costing me business",
};

export default async function NewPortalTicketPage() {
  // Nothing on this page is client-specific, but the gate still runs: an
  // unauthenticated visitor must never see the form at all.
  await requireClient();

  return (
    <>
      <PageHeader
        title="New request"
        description="Tell us what has happened and we will pick it up."
        category="support"
        actions={
          <Button asChild variant="secondary">
            <Link href="/portal/support">
              <ArrowLeft aria-hidden strokeWidth={1.75} />
              Back to support
            </Link>
          </Button>
        }
      />

      <div className="max-w-2xl rounded-xl border bg-card p-5 sm:p-6">
        <PortalForm action={createPortalTicket} submitLabel="Raise request" ariaLabel="New support request">
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="subject">Subject</Label>
              <Input id="subject" name="subject" required maxLength={200} className="h-11 bg-card" />
              <p className="text-meta text-muted-foreground">One line: what is this about?</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="severity">How urgent is it?</Label>
              {/* `critical` is deliberately absent — see PORTAL_SEVERITIES. */}
              <PortalSelect id="severity" name="severity" defaultValue="medium">
                {PORTAL_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {SEVERITY_LABEL[severity]}
                  </option>
                ))}
              </PortalSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="body">What has happened?</Label>
              <Textarea id="body" name="body" required rows={6} maxLength={8000} className="min-h-40 bg-card" />
              <p className="text-meta text-muted-foreground">
                Anything that helps us reproduce it — a page address, the time it happened, what you expected.
              </p>
            </div>
          </div>
        </PortalForm>
      </div>
    </>
  );
}
