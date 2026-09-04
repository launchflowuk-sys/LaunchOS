import { z } from "zod";

/**
 * The two fields `sendApprovedInvoice` and `sendAdReport` write on the record
 * they emailed. Both keep their claim when the provider rejects the message —
 * rolling it back would re-arm a second email — so the row still reads `sent`,
 * and `lastSendError` is the only thing that says the client never got it.
 */
const SendMetadata = z.object({
  lastSendError: z.object({ at: z.string(), to: z.string().optional(), message: z.string() }).optional(),
  emailedAt: z.string().optional(),
});

export interface SendFailure {
  readonly at: string;
  readonly to?: string | undefined;
  readonly message: string;
}

/**
 * The unresolved send failure a record is still carrying, or null.
 *
 * `emailedAt` is stamped only once the provider has taken the message, so an
 * `emailedAt` *later than* the error means a subsequent send worked and the
 * error is history. Anything else — an error with no confirmation, or a
 * confirmation older than the error — is a client who has not been emailed,
 * and the screen has to say so: the owner notification and the client activity
 * row both scroll away, and the status badge cheerfully reads "sent".
 */
export function readSendFailure(metadata: unknown): SendFailure | null {
  const parsed = SendMetadata.safeParse(metadata);
  if (!parsed.success || !parsed.data.lastSendError) return null;
  const { lastSendError, emailedAt } = parsed.data;
  const confirmed = emailedAt ? Date.parse(emailedAt) : Number.NaN;
  const failed = Date.parse(lastSendError.at);
  if (Number.isFinite(confirmed) && Number.isFinite(failed) && confirmed >= failed) return null;
  return lastSendError;
}
