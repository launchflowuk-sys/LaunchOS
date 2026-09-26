/**
 * A single JSON (or text) request with a hard timeout, shared by every infra
 * provider client (Hetzner today, Coolify-instance in Task 3). Kept separate
 * from `./coolify/` because that adapter talks to one Coolify app's API for
 * hosting status, not to the Coolify instance itself or to Hetzner.
 */
export class InfraAuthError extends Error {
  constructor(readonly status: number) {
    super(`The provider refused the token (HTTP ${status}).`);
    this.name = "InfraAuthError";
  }
}
export class InfraRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraRequestError";
  }
}

const MAX_BODY = 300;

/** One JSON (or text) request with a hard timeout. Never includes the token in an error. */
export async function infraRequest(
  url: string,
  init: {
    method?: string;
    token: string;
    body?: unknown;
    fetch?: typeof fetch | undefined;
    timeoutMs?: number | undefined;
    text?: boolean;
  },
): Promise<unknown> {
  const f = init.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${init.token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new InfraRequestError(
      `${init.method ?? "GET"} ${new URL(url).pathname} failed: ${error instanceof Error ? error.name : "network error"}`,
    );
  }
  if (res.status === 401 || res.status === 403) throw new InfraAuthError(res.status);
  const raw = await res.text();
  if (!res.ok) throw new InfraRequestError(`${init.method ?? "GET"} ${new URL(url).pathname} → ${res.status}: ${raw.slice(0, MAX_BODY)}`);
  if (init.text) return raw;
  return raw === "" ? null : JSON.parse(raw);
}
