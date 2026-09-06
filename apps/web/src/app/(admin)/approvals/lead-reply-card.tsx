import { LeadReplyPayload } from "@launchos/core";
import type { schema } from "@launchos/db";
import Link from "next/link";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { formatPence } from "@/lib/format";
import { LeadReplyDecision } from "./lead-reply-decision";

/**
 * The Lead Qualifier's drafted reply to a new enquiry — the one approval
 * where the thing being released is a paragraph of text to a stranger, so
 * the text *is* the card: the enquiry as it arrived, the draft in a box the
 * approver can edit before sending, the package the agent suggested at its
 * real price, and the questions it asked. Approve sends what is in the box
 * from the support mailbox with the booking link appended; reject sends
 * nothing. The card carries its own decision form because the body has to
 * travel with the verdict.
 */
export function LeadReplyRequest({ approval }: { approval: typeof schema.approvals.$inferSelect }) {
  const payload = LeadReplyPayload.safeParse(approval.payload);
  if (!payload.success) {
    return (
      <InlineAlert tone="danger" title="This request cannot be shown">
        The stored draft does not match what this screen expects, so approve nothing until it has been checked from the
        lead&rsquo;s page.
      </InlineAlert>
    );
  }
  const reply = payload.data;
  const who = reply.leadBusiness ? `${reply.leadName} at ${reply.leadBusiness}` : reply.leadName;

  return (
    <>
      <InlineAlert tone="warning" title="What approving does">
        Emails the text below to {reply.leadEmail} from the support mailbox, with their booking link added at the end, and
        marks the lead as contacted. Edit the text first if you like — what is in the box is what goes. Rejecting sends
        nothing.
      </InlineAlert>

      <div className="rounded-xl border bg-card p-4">
        <p className="label-caps text-muted-foreground">Their enquiry</p>
        {reply.leadMessage ? (
          <p className="mt-2 text-sm break-words whitespace-pre-wrap">{reply.leadMessage}</p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No message — just their details.</p>
        )}
      </div>

      <KeyValue
        columns={2}
        items={[
          {
            label: "To",
            value: (
              <Link href={`/leads/${reply.leadId}`} className="text-primary underline underline-offset-2">
                {who}
              </Link>
            ),
            hint: reply.leadEmail,
          },
          { label: "Subject", value: reply.subject },
          {
            label: "Suggested package",
            value: reply.suggestedPackageName
              ? `${reply.suggestedPackageName}${reply.suggestedPackageMonthlyPence !== null ? ` — ${formatPence(reply.suggestedPackageMonthlyPence)}/month` : ""}`
              : "None",
          },
          {
            label: "Questions asked",
            value:
              reply.questions.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-4">
                  {reply.questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              ) : (
                "None"
              ),
          },
        ]}
      />

      <LeadReplyDecision approvalId={approval.id} draft={reply.body} bookingUrl={reply.bookingUrl} />
    </>
  );
}
