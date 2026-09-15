import { createHmac } from "node:crypto";
import { createHttpRuntime, sendWithRetry, type AdsHttpOptions } from "../ads/http.js";
import { SocialApiError, SocialAuthError } from "./errors.js";
import { graphFailure, isGraphRetryable } from "./graph-error.js";
import { META_GRAPH_API_VERSION } from "./meta.js";

/**
 * Which Facebook Pages the system-user token can actually act on.
 *
 * This is the question that cannot be answered from our own tables, and it is
 * the one that silently breaks publishing. A Page can be sitting in the
 * Business portfolio, with the client having granted everything they were
 * asked for, and still be invisible to the token — because **a system user
 * does not inherit the portfolio's assets.** Each Page has to be assigned to
 * it by hand (Business Settings → Users → System Users → Add Assets), and a
 * Page that has not been produces exactly the same failure as a missing
 * permission.
 *
 * So `me/accounts` is the ground truth for "is this client connected", and it
 * is what the connectivity panel reads. Nothing else in Graph answers it: the
 * portfolio's `owned_pages` says what the business has, not what this token
 * may use.
 */

const META_GRAPH_ENDPOINT = "https://graph.facebook.com";

/** Graph caps a page of accounts; the token is a handful of Pages, not thousands. */
const PAGE_LIMIT = 100;

export interface ReachablePage {
  readonly id: string;
  readonly name: string;
}

export interface PageAccessOptions extends AdsHttpOptions {
  apiVersion?: string;
  endpoint?: string;
}

/**
 * Every Page the token can use, or `SocialAuthError` when Meta is not
 * configured at all.
 *
 * The distinction matters to the caller: "Meta is not connected" is Shoji's
 * job and reads as a blocked check, while "connected, and this client's Page
 * is not in the list" is the client's Page needing assignment and reads as a
 * missing one. Collapsing them would tell him to chase a client for something
 * only he can fix.
 */
export async function listReachablePages(
  env: NodeJS.ProcessEnv,
  options: PageAccessOptions = {},
): Promise<ReachablePage[]> {
  const accessToken = env.META_ADS_ACCESS_TOKEN?.trim();
  const appSecret = env.META_ADS_APP_SECRET?.trim();
  if (!accessToken || !appSecret) {
    throw new SocialAuthError("facebook", 0, "", "META_ADS_ACCESS_TOKEN and META_ADS_APP_SECRET are not set; connect Meta first");
  }

  const apiVersion = options.apiVersion ?? env.META_ADS_API_VERSION?.trim() ?? META_GRAPH_API_VERSION;
  const endpoint = (options.endpoint ?? META_GRAPH_ENDPOINT).replace(/\/+$/, "");
  const proof = createHmac("sha256", appSecret).update(accessToken).digest("hex");
  const url = `${endpoint}/${apiVersion}/me/accounts?fields=id,name&limit=${PAGE_LIMIT}&appsecret_proof=${proof}`;

  const reply = await sendWithRetry(createHttpRuntime(options), {
    url,
    // Bearer header, never a query parameter, so the token stays out of logs.
    init: { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
  }, isGraphRetryable("GET"));
  if (!reply.ok) throw graphFailure("facebook", reply);

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.text) as unknown;
  } catch {
    throw new SocialApiError("facebook", reply.status, reply.text, "response body was not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SocialApiError("facebook", reply.status, reply.text, "response body was not a JSON object");
  }

  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const id = (row as { id?: unknown }).id;
    const name = (row as { name?: unknown }).name;
    if (typeof id !== "string" || id === "") return [];
    return [{ id, name: typeof name === "string" ? name : id }];
  });
}
