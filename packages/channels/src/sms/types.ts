/**
 * A message channel that carries a phone number rather than an address.
 *
 * SMS today; WhatsApp through the same interface once the Cloud API is on a
 * second number, because from here they are the same shape — a number, some
 * text, and a provider's id for the delivery.
 */

export interface InboundSms {
  /** The sender, in whatever the provider sent. Normalised by core, not here. */
  from: string;
  /** The number they messaged — one of ours. */
  to: string;
  body: string;
  /** The provider's id for this delivery, so a retry is not a second lead. */
  externalId: string;
  /** Which provider and product this arrived on: `sms`, later `whatsapp`. */
  channel: string;
  receivedAt: Date;
}

export interface SendSmsInput {
  to: string;
  body: string;
  /** Overrides the adapter's configured sender, when a channel needs it. */
  from?: string;
}

export interface SendSmsResult {
  externalId: string;
  /** False when the adapter is a mock, so callers can say so on screen. */
  delivered: boolean;
}

export interface SmsAdapter {
  readonly name: string;
  send(input: SendSmsInput): Promise<SendSmsResult>;
}

/** Raised when a webhook body is not something this provider could have sent. */
export class InboundSmsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundSmsRefused";
  }
}
