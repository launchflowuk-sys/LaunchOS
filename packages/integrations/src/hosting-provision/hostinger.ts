import {
  ProvisioningError,
  type HostingProvisioner, type InstallWordPressInput,
  type ProvisionedWebsite, type WordPressInstallation,
} from "./types.js";

/**
 * Hostinger's hosting API.
 *
 * Every path here was read out of Hostinger's own generated client
 * (`client/client.gen.go` in `hostinger/api-cli`) or verified against the live
 * account. None of it is guessed, and the reason that matters is that guessing
 * cost two wrong conclusions on this exact endpoint: the install route was once
 * reported as missing, and once as forbidden, when it was neither.
 *
 * The one that bites: **the list route and the install route are different.**
 *
 *   GET  /api/hosting/v1/wordpress/installations              — read, read-only
 *   POST /api/hosting/v1/accounts/{username}/wordpress/installations  — install
 *
 * POSTing to the first answers `405 Supported methods: GET, HEAD`, which reads
 * like a permissions problem and is not one.
 */

const DEFAULT_BASE_URL = "https://developers.hostinger.com/api";

export interface HostingerProvisionerOptions {
  apiToken: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class HostingerProvisioner implements HostingProvisioner {
  readonly name = "hostinger" as const;
  readonly live = true;

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: HostingerProvisionerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      // Method, path, status and body every time. A route mismatch and a real
      // failure are different problems and must not read the same.
      throw new ProvisioningError(method, path, response.status, await response.text().catch(() => ""));
    }
    return response.json().catch(() => ({}));
  }

  async listWebsites(): Promise<ProvisionedWebsite[]> {
    const payload = (await this.request("GET", "/hosting/v1/websites")) as { data?: unknown[] } | unknown[];
    const rows = (Array.isArray(payload) ? payload : payload.data ?? []) as Record<string, unknown>[];
    return rows.map((row) => ({
      domain: String(row.domain ?? ""),
      username: String(row.username ?? ""),
      rootDirectory: String(row.root_directory ?? ""),
      vhostType: String(row.vhost_type ?? ""),
      createdAt: row.created_at ? new Date(String(row.created_at)) : null,
    }));
  }

  /** Asynchronous: answers "Request accepted"; the site appears about ten seconds later. */
  async createWebsite(domain: string, orderId: number): Promise<void> {
    await this.request("POST", "/hosting/v1/websites", { domain, order_id: orderId });
  }

  async deleteWebsite(domain: string): Promise<void> {
    await this.request("DELETE", `/hosting/v1/websites/${encodeURIComponent(domain)}`);
  }

  async listInstallations(username: string, domain?: string): Promise<WordPressInstallation[]> {
    const query = new URLSearchParams({ username, ...(domain ? { domain } : {}) });
    const payload = (await this.request("GET", `/hosting/v1/wordpress/installations?${query}`)) as
      | { data?: unknown[] }
      | unknown[];
    const rows = (Array.isArray(payload) ? payload : payload.data ?? []) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      username: String(row.username ?? ""),
      domain: String(row.domain ?? ""),
      siteTitle: String(row.site_title ?? ""),
      url: String(row.url ?? ""),
      directory: String(row.directory ?? ""),
      language: String(row.language ?? ""),
      login: String(row.login ?? ""),
      email: String(row.email ?? ""),
      isValid: row.is_valid !== false,
      validationError: row.validation_error === null || row.validation_error === undefined
        ? null
        : String(row.validation_error),
    }));
  }

  /**
   * Queues the install. Takes one to two minutes to actually finish, so the
   * caller polls `listInstallations` — this returning is not the site being
   * ready.
   *
   * `overwrite` is sent only when explicitly true. Hostinger's default is
   * false, and false means the job fails rather than replacing a live site.
   */
  async installWordPress(input: InstallWordPressInput): Promise<void> {
    const path = `/hosting/v1/accounts/${encodeURIComponent(input.username)}/wordpress/installations`;
    await this.request("POST", path, {
      domain: input.domain,
      "site-title": input.siteTitle,
      credentials: {
        admin_email: input.adminEmail,
        admin_username: input.adminUser,
        admin_password: input.adminPassword,
      },
      ...(input.language ? { language: input.language } : {}),
      ...(input.autoUpdates ? { "auto-updates": input.autoUpdates } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
      ...(input.overwrite === true ? { overwrite: true } : {}),
    });
  }
}
