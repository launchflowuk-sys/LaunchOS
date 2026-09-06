import { MockPaymentsAdapter, type PaymentsAdapter } from "@launchos/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";

const session = vi.fn<() => Promise<{ userId: string; role: "owner" | "staff" } | null>>();
let adapter: PaymentsAdapter = new MockPaymentsAdapter();
vi.mock("@/lib/session", () => ({ getSession: () => session() }));
vi.mock("@/lib/integrations", () => ({ getPayments: () => adapter }));

import { POST } from "./route.js";

const OWNER = { userId: "u1", role: "owner" as const };

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/dev/mock-payments", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

const SEED = {
  catalog: [{ priceId: "price_e2e", productId: "prod_e2e", productName: "LaunchFlow E2E", amountPence: 4900 }],
  subscriptions: [{
    id: "sub_e2e", customerId: "cus_e2e", customerEmail: "owner@tilbury.example", customerName: "Tilbury Taxis",
    priceId: "price_e2e", productId: "prod_e2e", amountPence: 4900,
    currentPeriodStart: "2026-09-01T00:00:00Z", currentPeriodEnd: "2026-10-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z",
  }],
};

describe("POST /api/dev/mock-payments", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    adapter = new MockPaymentsAdapter();
    session.mockReset();
  });

  it("seeds the mock's catalogue and subscriptions for a signed-in owner, and clears them on an empty body", async () => {
    session.mockResolvedValue(OWNER);
    const res = await post(SEED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, catalog: 1, subscriptions: 1 });
    expect(await adapter.listCatalog()).toEqual([expect.objectContaining({ productId: "prod_e2e", interval: "month", intervalCount: 1, currency: "GBP", productActive: true })]);
    const [sub] = await adapter.listSubscriptions();
    expect(sub).toMatchObject({ id: "sub_e2e", status: "active", providerStatus: "active", customerEmail: "owner@tilbury.example" });
    expect(sub!.currentPeriodEnd).toBeInstanceOf(Date);
    // No `undefined` keys: the adapter's types are exact about optional fields.
    expect(Object.keys(sub!)).not.toContain("cancelAt");

    expect((await post({})).status).toBe(200);
    expect(await adapter.listSubscriptions()).toEqual([]);
  });

  it("wants a signed-in owner", async () => {
    session.mockResolvedValue(null);
    expect((await post(SEED)).status).toBe(401);
    session.mockResolvedValue({ userId: "u2", role: "staff" });
    expect((await post(SEED)).status).toBe(403);
    expect(await adapter.listSubscriptions()).toEqual([]);
  });

  it("refuses when the adapter is not the mock, and a body that is not a seed", async () => {
    session.mockResolvedValue(OWNER);
    adapter = { name: "stripe" } as unknown as PaymentsAdapter;
    expect((await post(SEED)).status).toBe(409);
    adapter = new MockPaymentsAdapter();
    expect((await post({ subscriptions: [{ id: "sub_x" }] })).status).toBe(400);
  });

  it("does not exist in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    session.mockResolvedValue(OWNER);
    expect((await post(SEED)).status).toBe(404);
    expect(await adapter.listSubscriptions()).toEqual([]);
  });
});
