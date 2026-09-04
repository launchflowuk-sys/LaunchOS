import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import type { PaymentsAdapter, PaymentsWebhookEvent } from "@launchos/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendJobMock } = vi.hoisted(() => ({
  sendJobMock: vi.fn<(name: string, data: unknown, opts?: unknown) => Promise<void>>(async () => undefined),
}));
vi.mock("@/lib/queue", () => ({ sendJob: sendJobMock }));

let currentDb: Db | undefined;
vi.mock("@/lib/db", () => ({ getDb: () => currentDb! }));

const VALID_SIGNATURE = "test-sig";

// The route refuses to run on anything but a fully configured Stripe adapter,
// so the fake reports the name the tests need per case.
let adapterName: PaymentsAdapter["name"] = "stripe";

/** A fake adapter — only `webhookVerify` is exercised by this route. */
const fakeAdapter: PaymentsAdapter = {
  get name() {
    return adapterName;
  },
  async createCustomer() {
    throw new Error("not used by this route");
  },
  async createSubscription() {
    throw new Error("not used by this route");
  },
  async cancelSubscription() {
    throw new Error("not used by this route");
  },
  async listInvoices() {
    throw new Error("not used by this route");
  },
  webhookVerify(rawBody: string, signature: string): PaymentsWebhookEvent {
    if (signature !== VALID_SIGNATURE) throw new Error("fake payments: invalid webhook signature");
    return JSON.parse(rawBody) as PaymentsWebhookEvent;
  },
};

vi.mock("@launchos/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@launchos/integrations")>();
  return { ...actual, createPaymentsAdapter: () => fakeAdapter };
});

import { POST } from "./route.js";

const ENDPOINT = "http://localhost/api/webhooks/stripe";

/**
 * `new Request(...)` does not set `content-length` — the runtime adds it at
 * network time — so the tests set it explicitly, the way a real HTTP client
 * (Stripe included) always does. `contentLength: null` models the chunked
 * request that has none.
 */
function req(body: string, signature?: string, contentLength?: string | null): Request {
  const headers: Record<string, string> = {};
  if (signature !== undefined) headers["stripe-signature"] = signature;
  const declared = contentLength === undefined ? String(Buffer.byteLength(body, "utf8")) : contentLength;
  if (declared !== null) headers["content-length"] = declared;
  return new Request(ENDPOINT, { method: "POST", headers, body });
}

describe("POST /api/webhooks/stripe", () => {
  beforeEach(() => {
    sendJobMock.mockClear();
    adapterName = "stripe";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  afterEach(() => {
    currentDb = undefined;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("refuses with 503 when the configured payments adapter is not Stripe", async () => {
    // The mock adapter accepts the literal signature "mock", so it must never
    // be reachable from a public endpoint.
    adapterName = "mock";
    const body = JSON.stringify({ id: "evt_forged", type: "invoice.paid", data: { object: { customer: "cus_known" } } });

    const res = await POST(req(body, VALID_SIGNATURE));

    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("not configured");
    expect(sendJobMock).not.toHaveBeenCalled();
  });

  it("refuses with 503 when STRIPE_WEBHOOK_SECRET is not set", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const res = await POST(req("{}", VALID_SIGNATURE));

    expect(res.status).toBe(503);
    expect(sendJobMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized body without verifying or enqueuing anything", async () => {
    // Unauthenticated callers must not be able to make the process buffer
    // whatever they like; the cap applies before the signature is even checked.
    const oversized = "x".repeat(1024 * 1024 + 1);

    const res = await POST(req(oversized, VALID_SIGNATURE));

    expect(res.status).toBe(413);
    expect(sendJobMock).not.toHaveBeenCalled();
  });

  it("rejects a request that declares no content-length, before buffering it", async () => {
    // A chunked POST with no declared length used to slip past the cap
    // entirely: Number(null ?? "0") is 0, which passes, and request.text()
    // then reads the whole stream into memory. Stripe always declares a length.
    const res = await POST(req("{}", VALID_SIGNATURE, null));

    expect(res.status).toBe(411);
    expect(sendJobMock).not.toHaveBeenCalled();
  });

  it("rejects a request whose content-length does not parse", async () => {
    // The safe reading of an unparseable length on a public endpoint is
    // "reject", not "skip the check".
    const res = await POST(req("{}", VALID_SIGNATURE, "not-a-number"));

    expect(res.status).toBe(411);
    expect(sendJobMock).not.toHaveBeenCalled();
  });

  it("still rejects a body that is larger than the content-length it declared", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);

    const res = await POST(req(oversized, VALID_SIGNATURE, "10"));

    expect(res.status).toBe(413);
    expect(sendJobMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no stripe-signature header", async () => {
    const res = await POST(req("{}"));
    expect(res.status).toBe(400);
    expect(sendJobMock).not.toHaveBeenCalled();
  });

  it("rejects a request that fails signature verification, without leaking why", async () => {
    const res = await POST(req("{}", "wrong-sig"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid signature");
    expect(sendJobMock).not.toHaveBeenCalled();
  });

  it("acknowledges but does not enqueue an event with no customer on it", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "ping", data: {} });
    const res = await POST(req(body, VALID_SIGNATURE));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; ignored?: string };
    expect(json.ignored).toBe("no customer on event");
    expect(sendJobMock).not.toHaveBeenCalled();
  });

  it("acknowledges but does not enqueue an event for an unlinked Stripe customer", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const body = JSON.stringify({ id: "evt_2", type: "invoice.paid", data: { object: { customer: "cus_unknown" } } });
      const res = await POST(req(body, VALID_SIGNATURE));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; ignored?: string };
      expect(json.ignored).toBe("unknown customer");
      expect(sendJobMock).not.toHaveBeenCalled();
    });
  });

  it("enqueues payments.webhook with a per-event singleton key when the customer is known", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `stripe-${randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
      await db.insert(schema.billingProfiles).values({
        organisationId: org!.id, clientId: client!.id, stripeCustomerId: "cus_known",
      });

      const providerEvent = { id: "evt_3", type: "invoice.paid", data: { object: { customer: "cus_known" } } };
      const res = await POST(req(JSON.stringify(providerEvent), VALID_SIGNATURE));

      expect(res.status).toBe(200);
      expect(sendJobMock).toHaveBeenCalledTimes(1);
      const [name, data, opts] = sendJobMock.mock.calls[0]!;
      expect(name).toBe("payments.webhook");
      expect(data).toEqual({ organisationId: org!.id, providerEvent });
      // A plain key, with no singletonSeconds window: job_i4 covers `failed`,
      // so a window here would silently drop the Stripe "Resend" that is the
      // only recovery path an event whose sync failed has.
      expect(opts).toEqual({ singletonKey: "stripe:evt_3" });
    });
  });
});
