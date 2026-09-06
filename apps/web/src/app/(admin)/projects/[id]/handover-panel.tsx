import {
  buildDeliveryReport,
  deliveryReportDocumentHtml,
  deliveryReportReference,
  deliveryReportTitle,
  deliverySignOffUrl,
  projectUpdateRecipients,
} from "@launchos/core";
import { ActionForm } from "@/components/action-form";
import { DocumentPreview } from "@/components/document-preview";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue, type KeyValueItem } from "@/components/key-value";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { sendHandoverAction } from "../delivery-actions";
import { whyHandoverRefused } from "../delivery-queue";

/** "a@b.co.uk, c@d.co.uk and 4 others" — a readable line however many there are. */
function summariseRecipients(recipients: readonly string[]): string {
  if (recipients.length === 0) return "nobody";
  const shown = recipients.slice(0, 3).join(", ");
  const rest = recipients.length - 3;
  return rest > 0 ? `${shown} and ${rest} ${rest === 1 ? "other" : "others"}` : shown;
}

/**
 * The handover: the document, the state it is in, and the one button that
 * moves it.
 *
 * Built the way the proposal screen is built, because it is the same shape of
 * thing — a compiled document, a public token, one recorded agreement — and a
 * second way of showing one of those would be the beginning of two.
 *
 * **The preview is the document.** `deliveryReportDocumentHtml` is the exact
 * HTML the worker hands to Chromium, in an `<iframe srcDoc sandbox="">`, so
 * this screen cannot drift from the PDF and no route has to exist to serve an
 * unsent one. It is fed the report this component already compiled rather
 * than going through `deliveryReportHtml`, which would compile it a second
 * time for the same bytes.
 *
 * **Nothing here can print a password.** The Access section of the document
 * names the doors; `listAccessLocations` never selected a key. That is
 * enforced in core and proved by its tests — this component only shows what
 * comes back.
 */
export async function HandoverPanel({ organisationId, projectId }: { organisationId: string; projectId: string }) {
  const db = getDb();
  const report = await buildDeliveryReport(db, organisationId, { projectId });
  const recipients = await projectUpdateRecipients(db, organisationId, report.project.clientId);
  const refusal = whyHandoverRefused(report, recipients);

  const { project, signOff } = report;
  const rendered = project.deliveryReportDocumentId !== null;
  const signOffUrl = project.signOffToken ? deliverySignOffUrl(project) : null;
  // A client with a dozen portal users would otherwise print a dozen addresses
  // into a hint line and push everything under it off the fold. Three names
  // and a count is what a person reads anyway.
  const audience = summariseRecipients(recipients);

  const items: KeyValueItem[] = [
    { label: "Reference", value: <span className="font-mono text-meta">{deliveryReportReference(project)}</span> },
    {
      label: "The PDF they were sent",
      value: rendered ? (
        <a href={`/api/documents/${project.deliveryReportDocumentId}`} className="text-primary underline underline-offset-2">
          Open the PDF
        </a>
      ) : (
        "Rendered when it is sent — the worker prints it, this app has no browser."
      ),
    },
    {
      label: "Sent",
      value: project.signOffSentAt ? formatDateTime(project.signOffSentAt) : "Not sent yet",
      ...(project.signOffSentAt ? { hint: `To ${audience}` } : {}),
    },
    {
      label: "Their link",
      value: signOffUrl ? (
        <span className="font-mono text-meta break-all">{signOffUrl}</span>
      ) : (
        "Minted when the handover is first rendered."
      ),
      ...(signOffUrl ? { hint: "Unguessable, and it is where they read the report and sign it off." } : {}),
    },
  ];

  const signedOff: KeyValueItem[] = signOff
    ? [
        { label: "Name", value: signOff.signedName },
        { label: "Email", value: signOff.signedEmail },
        { label: "Signed off", value: formatDateTime(signOff.signedAt) },
        { label: "From", value: signOff.ip ?? "—", ...(signOff.userAgent ? { hint: signOff.userAgent } : {}) },
        {
          label: "Signed copy",
          value: signOff.documentId ? (
            <a href={`/api/documents/${signOff.documentId}`} className="text-primary underline underline-offset-2">
              Open the countersigned PDF
            </a>
          ) : (
            "Being prepared — the worker renders it just after sign-off."
          ),
        },
      ]
    : [];

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <div className="min-w-0 space-y-4">
        {signOff ? (
          <InlineAlert tone="success" title={`Signed off by ${signOff.signedName}`}>
            {`On ${formatDate(signOff.signedAt)}. The care plan has started and the report is evidence now, so it cannot be re-rendered.`}
          </InlineAlert>
        ) : refusal ? (
          <InlineAlert tone="warning" title="Not ready to send">
            {refusal}
          </InlineAlert>
        ) : (
          <InlineAlert tone="info" title="What sending does">
            Renders the report on our headed paper, emails it to {audience} with their own sign-off page, and waits.
            Signing off is what closes the project, starts the care plan and opens the case study. Sending again is
            allowed — a client who lost the email needs another one.
          </InlineAlert>
        )}

        <KeyValue columns={2} items={items} />

        {signOff ? (
          <>
            <p className="label-caps text-muted-foreground">What we hold as the record</p>
            <KeyValue columns={2} items={signedOff} />
          </>
        ) : (
          <ActionForm
            action={sendHandoverAction}
            ariaLabel="Send this handover"
            success="Queued — the handover goes out in a moment"
          >
            <input type="hidden" name="projectId" value={project.id} />
            <Button type="submit" disabled={refusal !== null} className="max-sm:w-full">
              {project.signOffSentAt ? "Send it again" : "Send the handover"}
            </Button>
          </ActionForm>
        )}
      </div>

      <div className="min-w-0">
        <DocumentPreview html={deliveryReportDocumentHtml(report)} title={deliveryReportTitle(report)} />
      </div>
    </div>
  );
}
