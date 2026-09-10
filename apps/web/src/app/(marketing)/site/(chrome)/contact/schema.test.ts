import { describe, expect, it } from "vitest";
import { CONTACT_RATE_LIMIT, ContactSchema, contactLimiter, firstIssue } from "./schema";

describe("contact form schema", () => {
  it("accepts a real enquiry and drops blank optional fields", () => {
    const parsed = ContactSchema.parse({
      name: "  Monika ",
      email: "monika@example.test",
      phone: "",
      business: "",
      message: "A booking system for the salon.",
      page: "/contact",
    });
    expect(parsed).toEqual({
      name: "Monika",
      email: "monika@example.test",
      phone: undefined,
      business: undefined,
      message: "A booking system for the salon.",
      page: "/contact",
    });
  });

  it("names the field that is wrong, in the visitor's words", () => {
    const missing = ContactSchema.safeParse({ name: "", email: "x@example.test", message: "hi" });
    expect(missing.success).toBe(false);
    if (!missing.success) expect(firstIssue(missing.error, "?")).toBe("Enter your name");

    const badEmail = ContactSchema.safeParse({ name: "A", email: "not-an-address", message: "hi" });
    expect(badEmail.success).toBe(false);
    if (!badEmail.success) expect(firstIssue(badEmail.error, "?")).toBe("Enter a full email address");

    const noMessage = ContactSchema.safeParse({ name: "A", email: "a@example.test", message: "   " });
    expect(noMessage.success).toBe(false);
    if (!noMessage.success) expect(firstIssue(noMessage.error, "?")).toBe("Tell us what you need");
  });

  it("limits one address to five messages an hour", () => {
    const address = `test-${Date.now()}`;
    for (let i = 0; i < CONTACT_RATE_LIMIT.limit; i += 1) expect(contactLimiter.allow(address)).toBe(true);
    expect(contactLimiter.allow(address)).toBe(false);
    expect(contactLimiter.retryAfterSeconds(address)).toBeGreaterThan(0);
  });
});
