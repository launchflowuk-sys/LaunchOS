import { describe, expect, it } from "vitest";
import { createHostingerMailClientFromEnv, hostingerMailClient, mockHostingerMailClient } from "./hostinger-mail.js";

/** Shaped from the live responses of 26 Sep 2026, trimmed to what is read. */
function order(n: number, domain: string, extra: Record<string, unknown> = {}) {
  return {
    id: `OR${n}`,
    status: "active",
    is_trial: false,
    seats: 5,
    domain: { id: n, name: domain },
    plan: { name: "business_s", title: "Starter Business Email" },
    has_pending_upgrade: false,
    created_at: "2026-09-22T11:52:24Z",
    expires_at: "2027-09-22T11:52:24Z",
    ...extra,
  };
}

type Call = { url: string; auth: string | null };

function stub(routes: (url: string) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, auth: new Headers(init?.headers).get("authorization") });
    const { status = 200, body } = routes(input);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

describe("hostingerMailClient", () => {
  it("reads every page of orders, not just the first", async () => {
    const { calls, fetch } = stub((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const rows = page === 1 ? [order(1, "a.com"), order(2, "b.com")] : page === 2 ? [order(3, "C.com")] : [];
      return { body: { data: rows, meta: { current_page: page, per_page: 2, total: 3 } } };
    });
    const orders = await hostingerMailClient("tok", { fetch }).listOrders();

    expect(orders.map((o) => o.domain)).toEqual(["a.com", "b.com", "c.com"]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(calls[0]!.url).toContain("/api/mail/v1/orders");
    expect(calls[0]!.auth).toBe("Bearer tok");
    expect(orders[0]).toMatchObject({ id: "OR1", seats: 5, isTrial: false, planTitle: "Starter Business Email" });
    expect(orders[0]!.expiresAt?.toISOString()).toBe("2027-09-22T11:52:24.000Z");
  });

  it("stops on an empty page even if meta says there is more", async () => {
    const { calls, fetch } = stub(() => ({ body: { data: [], meta: { current_page: 1, per_page: 15, total: 99 } } }));
    expect(await hostingerMailClient("t", { fetch }).listOrders()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("reads mailboxes in both the wrapped and the bare shape", async () => {
    const box = {
      id: 7,
      address: "info@a.com",
      status: "active",
      status_reason: null,
      is_catchall: false,
      usage: { storage_used: 417, storage_quota: 1048576, messages_used: 9, messages_quota: 15000, synced_at: null },
    };
    const wrapped = stub(() => ({ body: { data: [box] } }));
    const bare = stub(() => ({ body: [box] }));

    const a = await hostingerMailClient("t", { fetch: wrapped.fetch }).listMailboxes("OR1");
    const b = await hostingerMailClient("t", { fetch: bare.fetch }).listMailboxes("OR1");

    expect(wrapped.calls[0]!.url).toMatch(/\/api\/mail\/v1\/orders\/OR1\/mailboxes$/);
    expect(a).toEqual(b);
    expect(a[0]).toEqual({
      id: "7",
      address: "info@a.com",
      status: "active",
      storageUsedKb: 417,
      storageQuotaKb: 1048576,
      messagesUsed: 9,
      messagesQuota: 15000,
    });
  });

  it("returns only the email subscriptions, with their expiry", async () => {
    const { fetch } = stub(() => ({
      body: [
        { id: "s1", name: "Starter Business Email", status: "active", billing_period: 1, billing_period_unit: "year", currency_code: "USD", total_price: 3588, renewal_price: 3588, is_auto_renewed: true, created_at: "2026-09-22T11:52:20Z", expires_at: "2027-09-22T11:52:24Z", next_billing_at: "2027-09-15T11:52:24Z" },
        { id: "s2", name: ".COM Domain", status: "active", renewal_price: 1599, expires_at: "2027-01-01T00:00:00Z" },
      ],
    }));
    const subs = await hostingerMailClient("t", { fetch }).listEmailSubscriptions();

    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ id: "s1", renewalPrice: 3588, currencyCode: "USD", billingPeriod: 1, billingPeriodUnit: "year" });
    expect(subs[0]!.createdAt?.toISOString()).toBe("2026-09-22T11:52:20.000Z");
    expect(subs[0]!.expiresAt?.toISOString()).toBe("2027-09-22T11:52:24.000Z");
    expect(subs[0]!.nextBillingAt?.toISOString()).toBe("2027-09-15T11:52:24.000Z");
  });

  it("throws a classified error on a rejected token and never puts the token in it", async () => {
    const { fetch } = stub(() => ({ status: 401, body: { message: "Unauthenticated." } }));
    const error = await hostingerMailClient("secret-token", { fetch }).listOrders().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("secret-token");
    expect((error as { kind?: string }).kind).toBe("auth");
  });

  it("throws on a shape it does not recognise rather than returning nothing", async () => {
    const { fetch } = stub(() => ({ body: { unexpected: true } }));
    await expect(hostingerMailClient("t", { fetch }).listOrders()).rejects.toThrow(/expected shape/);
  });
});

describe("createHostingerMailClientFromEnv", () => {
  it("is real with a token", () => {
    expect(createHostingerMailClientFromEnv({ HOSTINGER_API_TOKEN: "t" })?.name).toBe("hostinger");
  });

  it("is null without a token, so an empty mock is never mistaken for 'no email'", () => {
    expect(createHostingerMailClientFromEnv({})).toBeNull();
  });

  it("is the mock only when the environment asks for mocks", () => {
    expect(createHostingerMailClientFromEnv({ ALLOW_MOCK_ADAPTERS: "1" })?.name).toBe("mock");
  });
});

describe("mockHostingerMailClient", () => {
  it("serves only what it was given", async () => {
    const mock = mockHostingerMailClient({
      orders: [{ id: "OR1", status: "active", isTrial: false, seats: 2, domain: "a.com", planTitle: "P", createdAt: null, expiresAt: null }],
      mailboxes: { OR1: [] },
    });
    expect(await mock.listOrders()).toHaveLength(1);
    expect(await mock.listMailboxes("OR2")).toEqual([]);
    expect(await mockHostingerMailClient().listEmailSubscriptions()).toEqual([]);
  });
});
