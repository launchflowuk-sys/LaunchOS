import { ContentReportSendPayload } from "@launchos/core";
import type { schema } from "@launchos/db";
import Link from "next/link";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";

/**
 * A month's content report asking to be emailed to the client. The card is
 * the report's own summary line — what the client will read — plus the
 * numbers it rests on, from the approval payload the worker wrote.
 */
export function ContentReportSendRequest({ approval }: { approval: typeof schema.approvals.$inferSelect }) {
  const payload = ContentReportSendPayload.safeParse(approval.payload);
  if (!payload.success) {
    return (
      <InlineAlert tone="danger" title="This request cannot be shown">
        The stored report does not match what this screen expects, so approve nothing until it has been checked from the
        client&apos;s Content tab.
      </InlineAlert>
    );
  }
  const report = payload.data;

  return (
    <>
      <InlineAlert tone="warning" title="What approving does">
        Emails {report.clientName} their {report.monthName} content report — {report.published} of {report.planned} planned
        posts published — with a link to their portal. Rejecting leaves it unsent.
      </InlineAlert>

      <div className="rounded-xl border bg-card p-4">
        <p className="text-sm break-words whitespace-pre-wrap">{report.summary}</p>
      </div>

      <KeyValue
        columns={2}
        items={[
          {
            label: "Client",
            value: (
              <Link href={`/clients/${report.clientId}/content`} className="text-primary underline underline-offset-2">
                {report.clientName}
              </Link>
            ),
          },
          { label: "Month", value: report.monthName },
          { label: "Published", value: `${report.published} of ${report.planned} planned` },
          { label: "Requested by", value: report.requestedByKind === "system" ? "The monthly content report job" : "Staff" },
        ]}
      />
    </>
  );
}
