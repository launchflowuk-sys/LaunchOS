import type { SendSmsInput, SendSmsResult, SmsAdapter } from "./types.js";

/**
 * The adapter used until Twilio's keys are set.
 *
 * It keeps what it was asked to send so a test can assert on it, and says
 * plainly that nothing was delivered — `delivered: false` is what lets a screen
 * tell Shoji a reply was drafted but never left the building, rather than
 * implying a client received something they did not.
 */
export function mockSmsAdapter(): SmsAdapter & { sent: SendSmsInput[] } {
  const sent: SendSmsInput[] = [];
  return {
    name: "mock",
    sent,
    async send(input: SendSmsInput): Promise<SendSmsResult> {
      sent.push(input);
      return { externalId: `mock-${sent.length}`, delivered: false };
    },
  };
}
