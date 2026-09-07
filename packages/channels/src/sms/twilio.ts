import { createHmac, timingSafeEqual } from "node:crypto";
import { InboundSmsRefused, type InboundSms, type SendSmsInput, type SendSmsResult, type SmsAdapter } from "./types.js";

const API_ROOT = "https://api.twilio.com/2010-04-01";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** The number Twilio sends from, in E.164. */
  from: string;
}

/**
 * Twilio's signature over a webhook request.
 *
 * The scheme is theirs and is not negotiable: HMAC-SHA1, keyed with the account
 * auth token, over the exact URL Twilio requested followed by every POST
 * parameter sorted by name and concatenated as name-then-value with nothing
 * between. Base64, compared against `X-Twilio-Signature`.
 *
 * Two things this depends on, both easy to get wrong behind a proxy:
 *
 * - **The URL must be the one Twilio called**, including scheme, host and any
 *   query string. Behind Traefik the request's own host header is the public
 *   one, so it matches — but a rewrite that changes the path breaks every
 *   signature, and it will look like an attack rather than a config mistake.
 * - **The parameters must be the raw form fields**, before any coercion.
 *
 * Verification is the only thing standing between this endpoint and anyone who
 * knows its URL, since the payload itself carries nothing secret. Without it,
 * a stranger can post a message and manufacture a lead.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
  if (!signature || !authToken) return false;

  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Turns Twilio's form post into the shape core ingests.
 *
 * `NumMedia` above zero is a picture rather than a question. The text is still
 * carried, because a photo of a broken page with "can you fix this" is a real
 * enquiry — the attachment simply is not fetched here.
 */
export function parseTwilioInbound(params: Record<string, string>, now = new Date()): InboundSms {
  const from = params.From?.trim();
  const to = params.To?.trim();
  const externalId = params.MessageSid?.trim();
  if (!from || !to || !externalId) {
    throw new InboundSmsRefused("a Twilio message has From, To and MessageSid");
  }
  return {
    from,
    to,
    body: (params.Body ?? "").trim(),
    externalId,
    // WhatsApp arrives on the same webhook, prefixed, and is worth telling apart.
    channel: from.startsWith("whatsapp:") ? "whatsapp" : "sms",
    receivedAt: now,
  };
}

/** Twilio prefixes WhatsApp addresses; core wants the bare number. */
export function stripChannelPrefix(address: string): string {
  return address.replace(/^whatsapp:/i, "");
}

export function twilioSmsAdapter(config: TwilioConfig): SmsAdapter {
  return {
    name: "twilio",
    async send(input: SendSmsInput): Promise<SendSmsResult> {
      const body = new URLSearchParams({
        To: input.to,
        From: input.from ?? config.from,
        Body: input.body,
      });

      const res = await fetch(`${API_ROOT}/Accounts/${config.accountSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      if (!res.ok) {
        // Twilio's error body names the account; keep it out of the thrown message.
        const detail = await res.text().catch(() => "");
        console.error("[twilio] send failed", { status: res.status, detail: detail.slice(0, 400) });
        throw new Error(`Twilio refused the message (HTTP ${res.status})`);
      }

      const json = (await res.json()) as { sid?: string };
      return { externalId: json.sid ?? "", delivered: true };
    },
  };
}
