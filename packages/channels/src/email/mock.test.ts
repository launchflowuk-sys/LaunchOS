import { describe, expect, it } from "vitest";
import { createEmailAdapter } from "./factory.js";
import { MockEmailAdapter } from "./mock.js";

describe("email adapters", () => {
  it("records what the mock adapter was asked to send", async () => {
    const adapter = new MockEmailAdapter();
    const result = await adapter.send({ to: "jo@client.test", from: "support@launchflow.test", subject: "Re: Site", text: "Fixed." });
    expect(result.providerMessageId).toMatch(/^mock-/);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.subject).toBe("Re: Site");
  });

  it("defaults to the mock adapter and selects smtp only when asked", () => {
    expect(createEmailAdapter({}).name).toBe("mock");
    expect(createEmailAdapter({ EMAIL_ADAPTER: "mock", SMTP_HOST: "smtp.test" }).name).toBe("mock");
    expect(createEmailAdapter({ EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "587", MAIL_FROM: "s@t.test" }).name).toBe("smtp");
    expect(() => createEmailAdapter({ EMAIL_ADAPTER: "smtp" })).toThrow(/SMTP_HOST/);
  });
});
