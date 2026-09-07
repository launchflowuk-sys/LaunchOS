import { mockSmsAdapter } from "./mock.js";
import { twilioSmsAdapter } from "./twilio.js";
import type { SmsAdapter } from "./types.js";

/**
 * Twilio when all three keys are set, the mock otherwise.
 *
 * Mock-first, like every other integration here: an unset key is a warning at
 * startup and a mock at runtime, never a crash. A half-set trio is the one case
 * worth refusing — `TWILIO_ACCOUNT_SID` without a token is a typo, not an
 * intention, and quietly answering with a mock would hide it until somebody
 * wondered why no client ever replied.
 */
export function smsAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): SmsAdapter {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_SMS_FROM?.trim();

  const set = [accountSid, authToken, from].filter(Boolean).length;
  if (set === 0) return mockSmsAdapter();
  if (set < 3) {
    throw new Error(
      "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_SMS_FROM must be set together, or none of them",
    );
  }
  return twilioSmsAdapter({ accountSid: accountSid!, authToken: authToken!, from: from! });
}
