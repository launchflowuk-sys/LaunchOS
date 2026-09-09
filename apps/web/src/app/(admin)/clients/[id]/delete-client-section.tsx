import { clientDeletionReport } from "@launchos/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { InlineAlert } from "@/components/inline-alert";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { deleteClientAction } from "../actions";

/**
 * Deleting a client, with what stands in the way shown before anything is
 * typed.
 *
 * Money blocks: paid invoices and recorded payments are the business's own
 * accounting records and a live subscription would carry on charging a client
 * this system had forgotten. Work only warns: it is listed, it will go, and a
 * person confirms it.
 *
 * The distinction is the feature. A dialog that lists a paid invoice next to a
 * task, both in the same grey, teaches you to click through it.
 */
export async function DeleteClientSection({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const report = await clientDeletionReport(getDb(), session.organisationId, clientId);

  return (
    <Section
      title="Delete this client"
      description="Archiving keeps everything and hides the client. Deleting removes it and everything filed under it, for good."
    >
      <div className="rounded-[20px] border bg-card p-5">
        {report.blockers.length > 0 ? (
          <InlineAlert tone="danger" title="This client cannot be deleted">
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {report.blockers.map((blocker) => (
                <li key={blocker.kind}>{blocker.detail}</li>
              ))}
            </ul>
            <p className="mt-3">
              Archive it instead — it disappears from your lists and keeps every record. Archived clients live at{" "}
              <Link href="/clients/archive" className="text-primary hover:underline">
                Clients → Archived
              </Link>{" "}
              and can be restored.
            </p>
          </InlineAlert>
        ) : (
          <>
            {report.warnings.length > 0 ? (
              <InlineAlert tone="warning" title="This will also delete">
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {report.warnings.map((warning) => (
                    <li key={warning.kind}>
                      {warning.count} {warning.kind}
                    </li>
                  ))}
                </ul>
              </InlineAlert>
            ) : (
              <p className="text-row text-muted-foreground">
                Nothing is filed under this client. Deleting removes the client record itself.
              </p>
            )}

            <ActionForm
              action={deleteClientAction}
              ariaLabel={`Delete ${report.clientName}`}
              success="Client deleted"
              className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end"
            >
              <input type="hidden" name="clientId" value={clientId} />
              <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
                <Label htmlFor={`delete-client-${clientId}`}>Type the client name to confirm</Label>
                <Input
                  id={`delete-client-${clientId}`}
                  name="confirmName"
                  placeholder={report.clientName}
                  autoComplete="off"
                />
              </div>
              <Button type="submit" variant="destructive" className="max-sm:w-full">
                Delete client
              </Button>
            </ActionForm>
          </>
        )}
      </div>
    </Section>
  );
}
