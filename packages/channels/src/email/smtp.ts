import { createTransport, type Transporter } from "nodemailer";
import { OutboundEmailSchema, type EmailAdapter, type OutboundEmail, type SendResult } from "./types.js";

export interface SmtpConfig { host: string; port: number; user?: string | undefined; pass?: string | undefined; secure: boolean }

export class SmtpEmailAdapter implements EmailAdapter {
  readonly name = "smtp" as const;
  private readonly transport: Transporter;

  constructor(config: SmtpConfig, transport?: Transporter) {
    this.transport =
      transport ??
      createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
      });
  }

  async send(msg: OutboundEmail): Promise<SendResult> {
    const m = OutboundEmailSchema.parse(msg);
    const info = await this.transport.sendMail({
      to: m.to, from: m.from, replyTo: m.replyTo, subject: m.subject, text: m.text, html: m.html,
      inReplyTo: m.inReplyTo, references: m.references,
    });
    return { providerMessageId: info.messageId, acceptedAt: new Date().toISOString() };
  }
}
