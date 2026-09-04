import { z } from "zod";

export const OutboundEmailSchema = z.object({
  to: z.string().email(),
  from: z.string().min(3),
  replyTo: z.string().email().optional(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
});
export type OutboundEmail = z.infer<typeof OutboundEmailSchema>;

export interface SendResult { providerMessageId: string; acceptedAt: string }

export interface EmailAdapter {
  readonly name: "mock" | "smtp";
  send(msg: OutboundEmail): Promise<SendResult>;
}
