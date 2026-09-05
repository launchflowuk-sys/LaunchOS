import type { FetchLike } from "./http.js";

export interface StubReply {
  status?: number;
  /** A string is sent verbatim; anything else is JSON-encoded. */
  body: unknown;
  headers?: Record<string, string>;
}

export interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface FetchStub {
  fetch: FetchLike;
  calls: StubCall[];
  slept: number[];
  sleep: (ms: number) => Promise<void>;
  remaining: () => number;
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    record[key.toLowerCase()] = value;
  }
  return record;
}

/**
 * A queued-reply `fetch`, so an adapter test asserts on what was actually sent
 * rather than on a mocked method call. Not a test file itself — vitest only
 * collects `*.test.ts`.
 */
export function fetchStub(replies: StubReply[]): FetchStub {
  const queue = [...replies];
  const calls: StubCall[] = [];
  const slept: number[] = [];
  return {
    calls,
    slept,
    remaining: () => queue.length,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: headerRecord(init),
        body: typeof init?.body === "string" ? init.body : "",
      });
      const next = queue.shift();
      if (next === undefined) throw new Error(`fetchStub: no reply queued for ${url}`);
      const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
      return new Response(body, { status: next.status ?? 200, headers: next.headers ?? {} });
    },
  };
}
