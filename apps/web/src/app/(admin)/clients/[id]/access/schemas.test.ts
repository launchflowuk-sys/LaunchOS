import { ACCESS_KINDS } from "@launchos/core";
import { describe, expect, it } from "vitest";
import { ACCESS_KIND_VALUES, EditAccessEntrySchema, NewAccessEntrySchema } from "./schemas";

const CLIENT_ID = "3f7d8a8e-9c8e-4d3c-9c0a-2b1e6f3d4a5b";

describe("access entry schemas", () => {
  it("lists exactly the kinds core knows, in the same order", () => {
    expect([...ACCESS_KIND_VALUES]).toEqual([...ACCESS_KINDS]);
  });

  it("turns blank inputs into nothing and a typed port into a number", () => {
    const parsed = NewAccessEntrySchema.parse({
      clientId: CLIENT_ID, kind: "server", label: " Hetzner ", url: "", host: "88.198.0.1", port: "22", username: "", secret: "", siteId: "", notes: "",
    });
    expect(parsed).toEqual({ clientId: CLIENT_ID, kind: "server", label: "Hetzner", host: "88.198.0.1", port: 22 });
  });

  it("keeps a password exactly as typed and refuses a URL without a scheme or an impossible port", () => {
    expect(NewAccessEntrySchema.parse({ clientId: CLIENT_ID, kind: "other", label: "x", secret: " p@ss word " }).secret).toBe(" p@ss word ");
    expect(NewAccessEntrySchema.safeParse({ clientId: CLIENT_ID, kind: "dashboard", label: "x", url: "acme.test/wp-admin" }).success).toBe(false);
    expect(NewAccessEntrySchema.safeParse({ clientId: CLIENT_ID, kind: "dashboard", label: "x", url: "javascript:alert(1)" }).success).toBe(false);
    expect(NewAccessEntrySchema.safeParse({ clientId: CLIENT_ID, kind: "server", label: "x", port: "70000" }).success).toBe(false);
    expect(NewAccessEntrySchema.safeParse({ clientId: CLIENT_ID, kind: "server", label: "x", port: "ssh" }).success).toBe(false);
  });

  it("edit takes the stored port as a number and clearSecret as an optional tick", () => {
    const parsed = EditAccessEntrySchema.parse({ entryId: CLIENT_ID, clientId: CLIENT_ID, kind: "email", label: "Mailbox", port: 993 });
    expect(parsed.port).toBe(993);
    expect(parsed.clearSecret).toBeUndefined();
    expect(EditAccessEntrySchema.parse({ entryId: CLIENT_ID, clientId: CLIENT_ID, kind: "email", label: "Mailbox", clearSecret: true }).clearSecret).toBe(true);
  });
});
