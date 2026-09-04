import { describe, expect, it } from "vitest";
import { HttpUptimeProbe, isBlockedTarget } from "./index.js";

describe("isBlockedTarget", () => {
  it("allows ordinary public http and https urls", () => {
    for (const url of ["https://grayscabline.co.uk", "http://example.com/health", "https://8.8.8.8/"]) {
      expect(isBlockedTarget(url), url).toBe(false);
    }
  });

  it("blocks non-http(s) schemes, malformed urls, loopback, private, link-local and docker hosts", () => {
    const blocked = [
      "file:///etc/passwd",
      "ftp://example.com",
      "gopher://example.com",
      "not a url",
      "http://localhost:3000/",
      "https://LOCALHOST/",
      "http://127.0.0.1/",
      "http://127.5.5.5/",
      "http://10.0.0.7/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://host.docker.internal:8080/",
    ];
    for (const url of blocked) expect(isBlockedTarget(url), url).toBe(true);
  });

  it("does not block public addresses that merely look adjacent to private ranges", () => {
    for (const url of ["http://172.32.0.1/", "http://172.15.0.1/", "http://11.0.0.1/", "http://192.169.0.1/"]) {
      expect(isBlockedTarget(url), url).toBe(false);
    }
  });
});

describe("HttpUptimeProbe", () => {
  it("refuses a blocked target without performing a fetch", async () => {
    const probe = new HttpUptimeProbe();
    await expect(probe.check("http://169.254.169.254/latest/meta-data/")).resolves.toEqual({
      ok: false,
      error: "blocked target",
    });
    await expect(probe.check("file:///etc/passwd")).resolves.toEqual({ ok: false, error: "blocked target" });
  });
});
