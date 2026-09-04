import { describe, expect, it } from "vitest";
import { MockCloudflareDns } from "./index.js";
import { MockCmsProvider } from "../cms/index.js";

describe("mock outward providers", () => {
  it("records a DNS change and returns a deterministic record id", async () => {
    const dns = new MockCloudflareDns();
    const result = await dns.updateRecord({ zone: "grayscabline.co.uk", type: "A", name: "@", value: "203.0.113.10", ttl: 300 });
    expect(result.applied).toBe(true);
    expect(result.recordId).toMatch(/^mock-dns-/);
    expect(dns.changes).toHaveLength(1);
    expect(dns.changes[0]!.value).toBe("203.0.113.10");
  });

  it("records a CMS content change", async () => {
    const cms = new MockCmsProvider();
    const result = await cms.updateContent({ siteRef: "app_1", path: "/contact", contentMd: "New phone number." });
    expect(result.applied).toBe(true);
    expect(cms.changes[0]!.path).toBe("/contact");
  });
});
