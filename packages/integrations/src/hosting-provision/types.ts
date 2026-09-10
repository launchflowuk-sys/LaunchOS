/**
 * Creating a website and putting WordPress on it.
 *
 * The provisioning half of the chain: lead, brief, generated site, **hosting**,
 * **WordPress**, review URL, approval, client. Everything here is verified
 * against the live Hostinger account — see
 * `docs/superpowers/specs/2026-09-10-site-build-pipeline.md`.
 *
 * Provider-shaped rather than Hostinger-shaped, so a second host can be added
 * without touching anything above it. Mock-first per rule 4: the mock is what
 * tests use, and nothing here needs a live account to be built or reasoned
 * about.
 *
 * **Everything is asynchronous.** Creating a site answers "accepted" and the
 * site appears about ten seconds later; installing WordPress answers accepted
 * and takes one to two minutes. No call here treats a 2xx as done — each one
 * polls until the thing exists, or fails loudly on a timeout. A stage that
 * reported success early would hand the next stage a docroot that is not there.
 */

export interface ProvisionedWebsite {
  domain: string;
  /** The hosting account the site lives under. Needed for every WordPress call. */
  username: string;
  /** Absolute path on the host — where the generated files go over SFTP. */
  rootDirectory: string;
  /** `addon` for a domain of its own; `subdomain` when nested under a parent. */
  vhostType: string;
  createdAt: Date | null;
}

export interface WordPressInstallation {
  id: string;
  username: string;
  domain: string;
  siteTitle: string;
  url: string;
  /** Relative path within the docroot. Empty string means the site root. */
  directory: string;
  language: string;
  login: string;
  email: string;
  /** Hostinger's own verdict on whether the install is sound. */
  isValid: boolean;
  validationError: string | null;
}

export interface InstallWordPressInput {
  username: string;
  domain: string;
  siteTitle: string;
  adminEmail: string;
  adminUser: string;
  adminPassword: string;
  /** WordPress locale. Hostinger defaults to `en_US`; UK sites want `en_GB`. */
  language?: string | undefined;
  /** `all`, `minor` or `none`. Left to Hostinger's default when unset. */
  autoUpdates?: "all" | "minor" | "none" | undefined;
  /** Relative directory inside the docroot. The site root when unset. */
  directory?: string | undefined;
  /**
   * Replace an existing installation. **False by default and it must stay
   * that way**: with it false Hostinger's job fails rather than destroying a
   * live site, which is the idempotency guarantee, free.
   */
  overwrite?: boolean | undefined;
}

export interface ProvisionWordPressInput extends InstallWordPressInput {
  /** The hosting plan the site is created under, when it has to be created. */
  orderId: number;
}

export interface ProvisionResult {
  domain: string;
  /** What the client and the team open to look at it. */
  websiteUrl: string;
  /** Where somebody signs in to edit it. */
  adminUrl: string;
  status: "installed" | "already_installed" | "failed";
  /** Whether this call created the website, as opposed to finding it. */
  websiteCreated: boolean;
  /** Whether this call installed WordPress, as opposed to finding it. */
  wordpressInstalled: boolean;
  failureReason?: string | undefined;
  installation?: WordPressInstallation | undefined;
}

export interface HostingProvisioner {
  readonly name: "hostinger" | "mock";
  /** True when a real token is configured. A screen may say so. */
  readonly live: boolean;

  listWebsites(): Promise<ProvisionedWebsite[]>;
  createWebsite(domain: string, orderId: number): Promise<void>;
  deleteWebsite(domain: string): Promise<void>;
  listInstallations(username: string, domain?: string): Promise<WordPressInstallation[]>;
  installWordPress(input: InstallWordPressInput): Promise<void>;
}

/**
 * Carries the provider's own words, and the request that produced them.
 *
 * A route mismatch and a real failure look nothing alike and cost an hour when
 * confused — they already did, twice, on this very endpoint. So a failure says
 * which method and path produced which status, every time.
 */
export class ProvisioningError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body.slice(0, 300)}`);
    this.name = "ProvisioningError";
  }
}

/** Raised when a thing was accepted but never turned up. */
export class ProvisioningTimeout extends Error {
  constructor(what: string, waitedMs: number) {
    super(`${what} was accepted but had not appeared after ${Math.round(waitedMs / 1000)}s`);
    this.name = "ProvisioningTimeout";
  }
}
