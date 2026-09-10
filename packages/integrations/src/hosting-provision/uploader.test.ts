import { describe, expect, it } from "vitest";
import { createSiteUploaderFromEnv } from "./uploader-factory.js";
import { MockSiteUploader, filesFromGeneratedSite } from "./upload.js";

const FULL = {
  HOSTINGER_SFTP_HOST: "82.29.191.16",
  HOSTINGER_SFTP_USER: "u509477357",
  HOSTINGER_SFTP_PASSWORD: "secret",
};

describe("createSiteUploaderFromEnv", () => {
  it("is the mock until the whole credential is there", () => {
    expect(createSiteUploaderFromEnv({}).name).toBe("mock");
    expect(createSiteUploaderFromEnv(FULL).name).toBe("sftp");
  });

  /** 65002 is Hostinger's, not the SSH default. Assuming 22 costs an afternoon. */
  it("defaults to Hostinger's port rather than the SSH one", () => {
    expect(createSiteUploaderFromEnv(FULL).name).toBe("sftp");
    expect(createSiteUploaderFromEnv({ ...FULL, HOSTINGER_SFTP_PORT: "22" }).name).toBe("sftp");
  });

  /**
   * All four, not some. Falling back to the mock on a missing password would
   * mean a build reporting a successful upload having written nothing — the
   * client opens a blank page and nobody finds out until they say so.
   */
  it("refuses a partial credential rather than half-working", () => {
    for (const missing of ["HOSTINGER_SFTP_HOST", "HOSTINGER_SFTP_USER", "HOSTINGER_SFTP_PASSWORD"]) {
      const env = { ...FULL } as Record<string, string>;
      delete env[missing];
      expect(createSiteUploaderFromEnv(env).name, `missing ${missing}`).toBe("mock");
    }
  });

});

describe("filesFromGeneratedSite", () => {
  it("gives every page a real URL without needing rewrite rules", () => {
    const files = filesFromGeneratedSite({
      pages: [
        { path: "/", title: "Home", html: "<h1>Hi</h1>" },
        { path: "/services", title: "Services", html: "<h1>What we do</h1>" },
      ],
      css: "body{}",
    });

    expect(files.map((f) => f.path)).toEqual(["index.html", "services/index.html", "style.css"]);
  });

  it("wraps the body in a real document and links the stylesheet", () => {
    const [home] = filesFromGeneratedSite({ pages: [{ path: "/", title: "Taylor & Sons", html: "<p>Hi</p>" }], css: "body{}" });
    expect(home!.contents).toContain("<!doctype html>");
    expect(home!.contents).toContain('<link rel="stylesheet" href="/style.css" />');
    // The title is escaped: a business name with an ampersand is common.
    expect(home!.contents).toContain("Taylor &amp; Sons");
  });

  it("leaves the stylesheet out when there is none", () => {
    const files = filesFromGeneratedSite({ pages: [{ path: "/", title: "H", html: "<p/>" }], css: "   " });
    expect(files.map((f) => f.path)).toEqual(["index.html"]);
  });
});

describe("MockSiteUploader", () => {
  /** An empty upload is the failure worth catching before a client sees it. */
  it("refuses an empty site rather than silently writing nothing", async () => {
    await expect(new MockSiteUploader().upload("/root", [])).rejects.toThrow(/nothing to upload/);
  });
});
