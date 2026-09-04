import { describe, expect, it } from "vitest";
import { normalizeCloudflare, normalizeGeneric, normalizeInbound, normalizePostmark } from "./inbound.js";

describe("inbound normalisers", () => {
  it("normalises a Postmark inbound payload", () => {
    const out = normalizePostmark({
      From: "jo@client.test", FromName: "Jo", Subject: "Site is down",
      ToFull: [{ Email: "grays-cabline@support.launchflow.co.uk" }],
      TextBody: "The site shows a 503.", HtmlBody: "<p>The site shows a 503.</p>",
      MessageID: "abc-123",
      Headers: [{ Name: "In-Reply-To", Value: "<root@support.test>" }, { Name: "References", Value: "<root@support.test> <two@support.test>" }],
      Attachments: [{ Name: "screenshot.png", ContentType: "image/png", Content: "aGk=", ContentLength: 2 }],
    });
    expect(out.provider).toBe("postmark");
    expect(out.to).toEqual(["grays-cabline@support.launchflow.co.uk"]);
    expect(out.from).toBe("jo@client.test");
    expect(out.messageId).toBe("<abc-123>");
    expect(out.inReplyTo).toBe("<root@support.test>");
    expect(out.references).toEqual(["<root@support.test>", "<two@support.test>"]);
    expect(out.attachments).toEqual([{ name: "screenshot.png", contentType: "image/png", contentBase64: "aGk=" }]);
  });

  it("normalises a Cloudflare Email Routing forward", () => {
    const out = normalizeCloudflare({
      to: "grays-cabline@support.launchflow.co.uk", from: "jo@client.test", subject: "Hi", text: "Body",
      headers: { "message-id": "<cf-1@mx.test>", "in-reply-to": "<root@support.test>" },
    });
    expect(out.provider).toBe("cloudflare");
    expect(out.messageId).toBe("<cf-1@mx.test>");
    expect(out.inReplyTo).toBe("<root@support.test>");
    expect(out.attachments).toEqual([]);
  });

  it("normalises a generic payload and is reachable through normalizeInbound", () => {
    const payload = { to: ["a@support.test"], from: "b@c.test", subject: "S", text: "T", messageId: "<g-1@c.test>" };
    expect(normalizeGeneric(payload).messageId).toBe("<g-1@c.test>");
    expect(normalizeInbound("generic", payload).from).toBe("b@c.test");
  });

  it("rejects a payload with no recipient", () => {
    expect(() => normalizeGeneric({ to: [], from: "b@c.test", subject: "S", text: "T", messageId: "<x@c.test>" })).toThrow();
  });
});
