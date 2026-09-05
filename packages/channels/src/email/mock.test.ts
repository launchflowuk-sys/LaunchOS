import { describe, expect, it, vi } from "vitest";
import { createEmailAdapter } from "./factory.js";
import { MockEmailAdapter } from "./mock.js";
import { SmtpEmailAdapter } from "./smtp.js";

describe("email adapters", () => {
  it("records what the mock adapter was asked to send", async () => {
    const adapter = new MockEmailAdapter();
    const result = await adapter.send({ to: "jo@client.test", from: "support@launchflow.test", subject: "Re: Site", text: "Fixed." });
    expect(result.providerMessageId).toMatch(/^mock-/);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.subject).toBe("Re: Site");
  });

  it("records both halves of a branded message, not only the text one", async () => {
    const adapter = new MockEmailAdapter();
    await adapter.send({
      to: "jo@client.test", from: "support@launchflow.test", subject: "Re: Site",
      text: "Fixed.", html: "<p>Fixed.</p>",
    });
    expect(adapter.sent[0]!.text).toBe("Fixed.");
    expect(adapter.sent[0]!.html).toBe("<p>Fixed.</p>");
  });

  it("hands the smtp transport both halves, so the message goes out multipart", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "<1@relay.test>" }));
    // Only `sendMail` is reached; the rest of Transporter is not this test's business.
    const adapter = new SmtpEmailAdapter(
      { host: "smtp.test", port: 587, user: undefined, pass: undefined, secure: false },
      { sendMail } as never,
    );

    await adapter.send({
      to: "jo@client.test", from: "support@launchflow.test", subject: "Re: Site",
      text: "Fixed.", html: "<p>Fixed.</p>",
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: "Fixed.", html: "<p>Fixed.</p>" }));
  });

  it("defaults to the mock adapter and selects smtp only when asked", () => {
    expect(createEmailAdapter({}).name).toBe("mock");
    expect(createEmailAdapter({ EMAIL_ADAPTER: "mock", SMTP_HOST: "smtp.test" }).name).toBe("mock");
    expect(createEmailAdapter({ EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "587", MAIL_FROM: "s@t.test" }).name).toBe("smtp");
    expect(() => createEmailAdapter({ EMAIL_ADAPTER: "smtp" })).toThrow(/SMTP_HOST/);
  });
});
