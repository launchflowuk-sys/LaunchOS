import { describe, expect, it } from "vitest";
import { MockHostingProvisioner } from "./mock.js";
import { HostingerProvisioner } from "./hostinger.js";
import { provisionWordPressWebsite } from "./provision.js";
import { createHostingProvisionerFromEnv } from "./factory.js";
import { ProvisioningError, type HostingProvisioner } from "./types.js";

const INPUT = {
  orderId: 1007850501,
  username: "u000000000",
  domain: "taylorplumbing.test",
  siteTitle: "Taylor Plumbing",
  adminEmail: "sam@taylorplumbing.test",
  adminUser: "sam",
  adminPassword: "a-long-password",
  language: "en_GB",
};

/**
 * Tests must not actually wait, but the sleep must still *yield* — a no-op
 * never lets the event loop run, so the mock's timers never fire and every poll
 * times out. That is what happened the first time this ran, and it is a fair
 * proof that the polling is real rather than decorative.
 */
const fast = {
  pollIntervalMs: 1,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  websiteTimeoutMs: 500,
  installTimeoutMs: 500,
};

describe("provisionWordPressWebsite", () => {
  it("creates the website, installs WordPress, and reports both URLs", async () => {
    const host = new MockHostingProvisioner();
    const result = await provisionWordPressWebsite(host, INPUT, fast);

    expect(result.status).toBe("installed");
    expect(result.websiteCreated).toBe(true);
    expect(result.wordpressInstalled).toBe(true);
    expect(result.websiteUrl).toBe("https://taylorplumbing.test");
    expect(result.adminUrl).toBe("https://taylorplumbing.test/wp-admin");
    expect(result.installation?.siteTitle).toBe("Taylor Plumbing");
    expect(result.installation?.language).toBe("en_GB");
  });

  /** It runs from a job queue, and a job queue retries. */
  it("is idempotent: a second run creates nothing and installs nothing", async () => {
    const host = new MockHostingProvisioner();
    await provisionWordPressWebsite(host, INPUT, fast);

    const second = await provisionWordPressWebsite(host, INPUT, fast);

    expect(second.status).toBe("already_installed");
    expect(second.websiteCreated).toBe(false);
    expect(second.wordpressInstalled).toBe(false);
    expect(await host.listInstallations(INPUT.username, INPUT.domain)).toHaveLength(1);
  });

  it("uses a website that already exists rather than creating a second", async () => {
    const host = new MockHostingProvisioner();
    host.seedWebsite(INPUT.domain);

    const result = await provisionWordPressWebsite(host, INPUT, fast);

    expect(result.websiteCreated).toBe(false);
    expect(result.status).toBe("installed");
    expect(await host.listWebsites()).toHaveLength(1);
  });

  /** A timeout must be loud. The next step writes files into the docroot. */
  it("fails loudly when a created website never appears", async () => {
    const host: HostingProvisioner = {
      ...new MockHostingProvisioner(),
      name: "mock",
      live: false,
      listWebsites: async () => [],
      createWebsite: async () => {},
      deleteWebsite: async () => {},
      listInstallations: async () => [],
      installWordPress: async () => {},
    };

    const result = await provisionWordPressWebsite(host, INPUT, { ...fast, websiteTimeoutMs: 5 });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/had not appeared/);
    expect(result.wordpressInstalled).toBe(false);
  });

  it("reports a provider refusal with its method, path and status", async () => {
    const host: HostingProvisioner = {
      name: "mock", live: false,
      listWebsites: async () => [],
      createWebsite: async () => {
        throw new ProvisioningError("POST", "/hosting/v1/websites", 422, '{"message":"The domain field is required."}');
      },
      deleteWebsite: async () => {},
      listInstallations: async () => [],
      installWordPress: async () => {},
    };

    const result = await provisionWordPressWebsite(host, INPUT, fast);

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("POST /hosting/v1/websites");
    expect(result.failureReason).toContain("422");
  });
});

describe("HostingerProvisioner", () => {
  /**
   * The mistake this pins. The list route and the install route are different,
   * and POSTing to the list route answers 405 — which reads like a permissions
   * problem and is not one. It cost two wrong conclusions before it was caught.
   */
  it("installs against /accounts/{username}/wordpress/installations, not the list route", async () => {
    let seen = { method: "", url: "", body: "" };
    const host = new HostingerProvisioner({
      apiToken: "t",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { method: init.method ?? "", url: String(url), body: String(init.body ?? "") };
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await host.installWordPress({
      username: "u509477357", domain: "x.test", siteTitle: "X",
      adminEmail: "a@x.test", adminUser: "a", adminPassword: "p",
    });

    expect(seen.method).toBe("POST");
    expect(seen.url).toContain("/hosting/v1/accounts/u509477357/wordpress/installations");
    expect(seen.url).not.toMatch(/\/hosting\/v1\/wordpress\/installations$/);
    expect(JSON.parse(seen.body)).toMatchObject({
      domain: "x.test",
      "site-title": "X",
      credentials: { admin_email: "a@x.test", admin_username: "a", admin_password: "p" },
    });
  });

  /** False is Hostinger's default and means "fail rather than replace a live site". */
  it("sends overwrite only when explicitly asked", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body ?? ""));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const host = new HostingerProvisioner({ apiToken: "t", fetchImpl });
    const base = { username: "u1", domain: "x.test", siteTitle: "X", adminEmail: "a@x.test", adminUser: "a", adminPassword: "p" };

    await host.installWordPress(base);
    await host.installWordPress({ ...base, overwrite: true });

    expect(JSON.parse(bodies[0]!)).not.toHaveProperty("overwrite");
    expect(JSON.parse(bodies[1]!)).toMatchObject({ overwrite: true });
  });

  it("carries method, path, status and body on a refusal", async () => {
    const host = new HostingerProvisioner({
      apiToken: "t",
      fetchImpl: (async () => new Response('{"message":"nope"}', { status: 405 })) as unknown as typeof fetch,
    });

    await expect(host.listWebsites()).rejects.toThrow(/GET \/hosting\/v1\/websites → 405/);
  });

  it("reads the fields Hostinger actually returns", async () => {
    const host = new HostingerProvisioner({
      apiToken: "t",
      fetchImpl: (async () =>
        new Response(JSON.stringify({
          data: [{
            domain: "a.test", username: "u1", vhost_type: "addon",
            root_directory: "/home/u1/domains/a.test/public_html",
            created_at: "2026-09-10T03:47:27Z",
          }],
        }), { status: 200 })) as unknown as typeof fetch,
    });

    const [site] = await host.listWebsites();
    expect(site).toMatchObject({ domain: "a.test", username: "u1", vhostType: "addon" });
    expect(site!.rootDirectory).toContain("public_html");
  });
});

describe("createHostingProvisionerFromEnv", () => {
  it("is the mock until the token the registrar already uses is present", () => {
    expect(createHostingProvisionerFromEnv({}).name).toBe("mock");
    expect(createHostingProvisionerFromEnv({ HOSTINGER_API_TOKEN: "t" }).name).toBe("hostinger");
  });
});
