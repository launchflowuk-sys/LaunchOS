import { afterEach, describe, expect, it } from "vitest";
import { authorised, SECRET_HEADER } from "./inbound-auth";

/**
 * The only credential on the inbound mail route, and therefore the whole
 * boundary between "a client emailed us" and "anyone on the internet can raise
 * a ticket against any client". Two ways in, because the two providers we
 * support cannot both do the same one: Cloudflare and a generic forwarder set
 * a header, and Postmark's inbound stream has no header field at all — only a
 * URL, which is why it must be able to arrive as Basic credentials.
 */

const SECRET = "a-long-enough-inbound-secret-value";

function request(headers: Record<string, string>): Request {
  return new Request("https://example.test/api/webhooks/email/inbound", { method: "POST", headers });
}

/** `https://user:pass@host` reaches the server as this. */
function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

const original = process.env["INBOUND_EMAIL_SECRET"];
afterEach(() => {
  if (original === undefined) delete process.env["INBOUND_EMAIL_SECRET"];
  else process.env["INBOUND_EMAIL_SECRET"] = original;
});

describe("inbound webhook authorisation", () => {
  it("accepts the custom header", () => {
    process.env["INBOUND_EMAIL_SECRET"] = SECRET;
    expect(authorised(request({ [SECRET_HEADER]: SECRET }))).toBe(true);
  });

  it("accepts the secret as a Basic password, which is Postmark's only option", () => {
    process.env["INBOUND_EMAIL_SECRET"] = SECRET;
    expect(authorised(request({ authorization: basic("launchos", SECRET) }))).toBe(true);
  });

  it("accepts it as the Basic username too, since consoles differ", () => {
    process.env["INBOUND_EMAIL_SECRET"] = SECRET;
    expect(authorised(request({ authorization: basic(SECRET, "") }))).toBe(true);
  });

  it("refuses a wrong secret by either route", () => {
    process.env["INBOUND_EMAIL_SECRET"] = SECRET;
    expect(authorised(request({ [SECRET_HEADER]: "wrong" }))).toBe(false);
    expect(authorised(request({ authorization: basic("launchos", "wrong") }))).toBe(false);
  });

  it("refuses when nothing is presented", () => {
    process.env["INBOUND_EMAIL_SECRET"] = SECRET;
    expect(authorised(request({}))).toBe(false);
  });

  it("refuses everything when the secret is unset, rather than letting anyone in", () => {
    delete process.env["INBOUND_EMAIL_SECRET"];
    expect(authorised(request({ [SECRET_HEADER]: "anything" }))).toBe(false);
    expect(authorised(request({ authorization: basic("a", "b") }))).toBe(false);
  });

  it("is not fooled by a malformed or non-Basic Authorization header", () => {
    process.env["INBOUND_EMAIL_SECRET"] = SECRET;
    for (const header of [`Bearer ${SECRET}`, "Basic", "Basic !!!not-base64!!!", ""]) {
      expect(authorised(request({ authorization: header })), header).toBe(false);
    }
  });
});
