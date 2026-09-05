import { vi } from "vitest";

/**
 * A queued `fetch` for the DNS provider tests: hand it the responses the API
 * would give, in order, and read back exactly what was sent. Installed over the
 * global rather than injected, so the providers' own default `fetch` path is
 * the one under test.
 */

export interface StubbedResponse {
  status: number;
  /** Serialised as JSON. Use `text` for a body that is not JSON. */
  body?: unknown;
  text?: string;
}

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  authorization: string | undefined;
}

export interface FetchStub {
  readonly calls: RecordedRequest[];
}

export function stubFetch(responses: StubbedResponse[]): FetchStub {
  const calls: RecordedRequest[] = [];

  vi.stubGlobal("fetch", async (url: string, init?: RequestInit): Promise<Response> => {
    const next = responses[calls.length];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      authorization: headers.authorization,
    });
    if (!next) throw new Error(`unexpected request ${calls.length}: ${init?.method ?? "GET"} ${String(url)}`);
    return new Response(next.text ?? JSON.stringify(next.body ?? null), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });

  return { calls };
}
