import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mockSmsAdapter } from "./mock.js";
import { smsAdapterFromEnv } from "./factory.js";
import { parseTwilioInbound, stripChannelPrefix, verifyTwilioSignature } from "./twilio.js";
import { InboundSmsRefused } from "./types.js";

const TOKEN = "an-auth-token";
const URL_CALLED = "https://os.launchflow.co.uk/api/webhooks/sms/inbound";

/** Twilio's own scheme, so the test signs the way Twilio signs. */
function sign(url: string, params: Record<string, string>, token = TOKEN): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

const MESSAGE = {
  From: "+447700900123",
  To: "+441375000000",
  Body: "Do you build websites? How much for a small one?",
  MessageSid: "SM0123456789",
  AccountSid: "AC0123456789",
};

describe("verifyTwilioSignature", () => {
  it("accepts a request Twilio signed", () => {
    expect(verifyTwilioSignature(TOKEN, URL_CALLED, MESSAGE, sign(URL_CALLED, MESSAGE))).toBe(true);
  });

  it("refuses a body that was changed after signing — the whole point of it", () => {
    const signature = sign(URL_CALLED, MESSAGE);
    const tampered = { ...MESSAGE, From: "+447999999999" };
    expect(verifyTwilioSignature(TOKEN, URL_CALLED, tampered, signature)).toBe(false);
  });

  it("refuses a signature made for a different URL, so the endpoint cannot be replayed elsewhere", () => {
    const signature = sign("https://example.test/hook", MESSAGE);
    expect(verifyTwilioSignature(TOKEN, URL_CALLED, MESSAGE, signature)).toBe(false);
  });

  it("refuses a signature made with someone else's token", () => {
    expect(verifyTwilioSignature(TOKEN, URL_CALLED, MESSAGE, sign(URL_CALLED, MESSAGE, "not-the-token"))).toBe(false);
  });

  it("refuses a missing signature and refuses to work without a token", () => {
    expect(verifyTwilioSignature(TOKEN, URL_CALLED, MESSAGE, null)).toBe(false);
    expect(verifyTwilioSignature("", URL_CALLED, MESSAGE, sign(URL_CALLED, MESSAGE))).toBe(false);
  });
});

describe("parseTwilioInbound", () => {
  it("reads a text into the shape core ingests", () => {
    const now = new Date("2026-09-07T05:30:00Z");
    expect(parseTwilioInbound(MESSAGE, now)).toEqual({
      from: "+447700900123",
      to: "+441375000000",
      body: "Do you build websites? How much for a small one?",
      externalId: "SM0123456789",
      channel: "sms",
      receivedAt: now,
    });
  });

  it("tells WhatsApp apart, since it arrives on the same webhook", () => {
    const parsed = parseTwilioInbound({ ...MESSAGE, From: "whatsapp:+447700900123" });
    expect(parsed.channel).toBe("whatsapp");
    expect(stripChannelPrefix(parsed.from)).toBe("+447700900123");
  });

  it("keeps the words on a picture message rather than dropping the enquiry", () => {
    const parsed = parseTwilioInbound({ ...MESSAGE, NumMedia: "1", Body: "can you fix this page" });
    expect(parsed.body).toBe("can you fix this page");
  });

  it("refuses a post that is missing what a message must have", () => {
    expect(() => parseTwilioInbound({ Body: "hello" })).toThrow(InboundSmsRefused);
    expect(() => parseTwilioInbound({ ...MESSAGE, MessageSid: "" })).toThrow(/MessageSid/);
  });
});

describe("smsAdapterFromEnv", () => {
  it("is the mock when nothing is configured, and says nothing was delivered", async () => {
    const adapter = smsAdapterFromEnv({} as NodeJS.ProcessEnv);
    expect(adapter.name).toBe("mock");
    expect(await adapter.send({ to: "+447700900123", body: "hi" })).toMatchObject({ delivered: false });
  });

  it("is Twilio when all three keys are set", () => {
    const adapter = smsAdapterFromEnv({
      TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_SMS_FROM: "+441375000000",
    } as NodeJS.ProcessEnv);
    expect(adapter.name).toBe("twilio");
  });

  it("refuses a half-configured set rather than hiding a typo behind a mock", () => {
    expect(() => smsAdapterFromEnv({ TWILIO_ACCOUNT_SID: "AC1" } as NodeJS.ProcessEnv))
      .toThrow(/must be set together/);
    expect(() => smsAdapterFromEnv({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" } as NodeJS.ProcessEnv))
      .toThrow(/must be set together/);
  });
});

describe("mockSmsAdapter", () => {
  it("keeps what it was asked to send, so a test can read it back", async () => {
    const adapter = mockSmsAdapter();
    await adapter.send({ to: "+447700900123", body: "first" });
    await adapter.send({ to: "+447700900124", body: "second" });
    expect(adapter.sent.map((s) => s.body)).toEqual(["first", "second"]);
  });
});
