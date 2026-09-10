import {
  ProvisioningTimeout,
  type HostingProvisioner, type ProvisionResult, type ProvisionWordPressInput,
  type WordPressInstallation,
} from "./types.js";

/**
 * A website with WordPress on it, from a domain and a title.
 *
 * The order is fixed by the host and by what is safe:
 *
 *   1. Does the website exist? 2. If not, create it — and wait until it does.
 *   3. Is WordPress already there? If so, stop: that is success, not a clash.
 *   4. Install. 5. Wait until it appears. 6. Report the URLs.
 *
 * **Idempotent by construction.** Run it twice and the second run creates
 * nothing, installs nothing, and returns `already_installed`. That is not
 * politeness — this runs from a job queue, and a job queue retries.
 *
 * **Nothing is assumed complete because a call returned.** Both stages are
 * asynchronous: a created site appears about ten seconds later, an install
 * takes one to two minutes. Each is polled to a deadline, and a deadline that
 * passes is a loud failure rather than a quiet move to the next step — the next
 * step would be writing files into a docroot that does not exist.
 */

export interface ProvisionOptions {
  /** How long to wait for a created website to appear. */
  websiteTimeoutMs?: number | undefined;
  /** How long to wait for WordPress. Hostinger says one to two minutes. */
  installTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  /** Injected in tests so they do not actually wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const DEFAULTS = {
  websiteTimeoutMs: 90_000,
  installTimeoutMs: 300_000,
  pollIntervalMs: 5_000,
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns something, or the deadline passes. */
async function until<T>(
  check: () => Promise<T | undefined>,
  what: string,
  timeoutMs: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() - started >= timeoutMs) throw new ProvisioningTimeout(what, Date.now() - started);
    await sleep(intervalMs);
  }
}

export async function provisionWordPressWebsite(
  host: HostingProvisioner,
  input: ProvisionWordPressInput,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const websiteTimeoutMs = options.websiteTimeoutMs ?? DEFAULTS.websiteTimeoutMs;
  const installTimeoutMs = options.installTimeoutMs ?? DEFAULTS.installTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const sleep = options.sleep ?? wait;

  const urls = (installation?: WordPressInstallation) => ({
    websiteUrl: installation?.url || `https://${input.domain}`,
    adminUrl: `${(installation?.url || `https://${input.domain}`).replace(/\/+$/, "")}/wp-admin`,
  });

  try {
    // 1–2. The website, created only if it is not already there.
    const findSite = async () => (await host.listWebsites()).find((site) => site.domain === input.domain);
    let site = await findSite();
    const websiteCreated = site === undefined;

    if (!site) {
      await host.createWebsite(input.domain, input.orderId);
      site = await until(findSite, `website ${input.domain}`, websiteTimeoutMs, pollIntervalMs, sleep);
    }

    // The username comes from the host rather than the caller: it is the
    // hosting account the site actually landed on, and the install is addressed
    // by it. Taking it on trust from an input would be a guess.
    const username = site.username || input.username;

    // 3. Already installed is success. Doing it again is what `overwrite`
    // exists to refuse, and refusing is the right answer.
    const existing = (await host.listInstallations(username, input.domain))
      .find((row) => (row.directory ?? "") === (input.directory ?? ""));
    if (existing && input.overwrite !== true) {
      return {
        domain: input.domain,
        ...urls(existing),
        status: "already_installed",
        websiteCreated,
        wordpressInstalled: false,
        installation: existing,
      };
    }

    // 4–5. Queue it, then wait for it to actually be there.
    await host.installWordPress({ ...input, username });
    const installation = await until(
      async () =>
        (await host.listInstallations(username, input.domain))
          .find((row) => (row.directory ?? "") === (input.directory ?? "") && row.id !== existing?.id),
      `WordPress on ${input.domain}`,
      installTimeoutMs,
      pollIntervalMs,
      sleep,
    );

    return {
      domain: input.domain,
      ...urls(installation),
      status: "installed",
      websiteCreated,
      wordpressInstalled: true,
      installation,
    };
  } catch (error) {
    // Reported, not thrown. The caller is a job that has to record a failed
    // build against a client and move on, not one that should die.
    return {
      domain: input.domain,
      ...urls(),
      status: "failed",
      websiteCreated: false,
      wordpressInstalled: false,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}
