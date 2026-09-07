import { parseServiceAccountKey } from "./auth.js";
import { GoogleSearchConsoleAdapter, type GoogleSearchConsoleOptions } from "./google.js";
import { MockSearchConsoleAdapter } from "./mock.js";
import type { SearchConsoleAdapter } from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export { GoogleSearchConsoleAdapter, type GoogleSearchConsoleOptions } from "./google.js";
export { MockSearchConsoleAdapter } from "./mock.js";
export { parseServiceAccountKey, ServiceAccountTokenSource, SEARCH_CONSOLE_SCOPE, type ServiceAccountCredentials } from "./auth.js";

/**
 * One key, and deliberately only one.
 *
 * **Which property to read is not an environment variable.** Every client will
 * have their own, so it belongs on the client's row in the database next to the
 * rest of what LaunchOS knows about them — rule 1, the same reason nothing else
 * here is a global. The env holds the credential that can reach *any* property
 * the service account has been added to; the database says which one is whose.
 *
 * Base64 rather than raw JSON because the private key is a PEM full of
 * newlines and environment-variable editors each mangle those differently.
 * `parseServiceAccountKey` accepts both, so a local `.env` can hold the raw
 * file if that is easier to eyeball.
 */
export const SEARCH_CONSOLE_ENV_KEYS = ["GSC_SERVICE_ACCOUNT_JSON"] as const;

/** Whether a real adapter can be built from this environment. Blank counts as unset, as everywhere else. */
export function hasSearchConsoleCredentials(env: NodeJS.ProcessEnv): boolean {
  return SEARCH_CONSOLE_ENV_KEYS.every((key) => (env[key] ?? "").trim() !== "");
}

/**
 * The real adapter when the key is present, the mock otherwise.
 *
 * A malformed key throws rather than falling back. Falling back would mean a
 * screen quietly showing invented search traffic under a real client's name,
 * which is the failure `adapter-guard` exists to prevent everywhere else.
 */
export function createSearchConsoleFromEnv(
  env: NodeJS.ProcessEnv,
  options: GoogleSearchConsoleOptions = {},
): SearchConsoleAdapter {
  if (!hasSearchConsoleCredentials(env)) return new MockSearchConsoleAdapter();
  const credentials = parseServiceAccountKey(env.GSC_SERVICE_ACCOUNT_JSON ?? "");
  return new GoogleSearchConsoleAdapter(credentials, options);
}
