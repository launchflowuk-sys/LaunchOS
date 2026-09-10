import type {
  HostingProvisioner, InstallWordPressInput, ProvisionedWebsite, WordPressInstallation,
} from "./types.js";

/**
 * An in-memory host that behaves like the real one, including its awkward bits.
 *
 * It is asynchronous the way Hostinger is — a created site is not visible until
 * the next tick, an install takes a beat — because a mock that answers
 * instantly lets a caller get away with treating a 2xx as done, and then the
 * real adapter deploys into a docroot that does not exist yet. The delay is
 * what makes the polling code get written.
 *
 * It also refuses to overwrite an existing installation unless told to, because
 * that is the idempotency guarantee the whole design leans on.
 */
export class MockHostingProvisioner implements HostingProvisioner {
  readonly name = "mock" as const;
  readonly live = false;

  private readonly websites = new Map<string, ProvisionedWebsite>();
  private readonly installations = new Map<string, WordPressInstallation>();

  /** How long a created thing stays invisible. Small, but not zero. */
  constructor(private readonly latencyMs = 5, private readonly username = "u000000000") {}

  async listWebsites(): Promise<ProvisionedWebsite[]> {
    return [...this.websites.values()];
  }

  async createWebsite(domain: string, _orderId: number): Promise<void> {
    if (this.websites.has(domain)) return;
    // Accepted now, visible shortly — exactly like the real one.
    setTimeout(() => {
      this.websites.set(domain, {
        domain,
        username: this.username,
        rootDirectory: `/home/${this.username}/domains/${domain}/public_html`,
        vhostType: "addon",
        createdAt: new Date(),
      });
    }, this.latencyMs);
  }

  async deleteWebsite(domain: string): Promise<void> {
    setTimeout(() => {
      this.websites.delete(domain);
      for (const [key, install] of this.installations) {
        if (install.domain === domain) this.installations.delete(key);
      }
    }, this.latencyMs);
  }

  async listInstallations(username: string, domain?: string): Promise<WordPressInstallation[]> {
    return [...this.installations.values()].filter(
      (install) => install.username === username && (domain === undefined || install.domain === domain),
    );
  }

  async installWordPress(input: InstallWordPressInput): Promise<void> {
    const key = `${input.username}:${input.domain}:${input.directory ?? ""}`;
    // The real job fails rather than replacing a live site. So does this one.
    if (this.installations.has(key) && input.overwrite !== true) {
      throw new Error("WordPress is already installed here and overwrite is false");
    }
    setTimeout(() => {
      this.installations.set(key, {
        id: `mock-${this.installations.size + 1}`,
        username: input.username,
        domain: input.domain,
        siteTitle: input.siteTitle,
        url: `https://${input.domain}`,
        directory: input.directory ?? "",
        language: input.language ?? "en_US",
        login: input.adminUser,
        email: input.adminEmail,
        isValid: true,
        validationError: null,
      });
    }, this.latencyMs);
  }

  /** Test affordance: a site that exists before anybody asks for one. */
  seedWebsite(domain: string): void {
    this.websites.set(domain, {
      domain,
      username: this.username,
      rootDirectory: `/home/${this.username}/domains/${domain}/public_html`,
      vhostType: "addon",
      createdAt: new Date(),
    });
  }
}
