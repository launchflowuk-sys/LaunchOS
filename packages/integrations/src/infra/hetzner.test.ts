import { describe, expect, it, vi } from "vitest";
import { eurCents, hetznerClient, mockHetznerClient } from "./hetzner.js";
import { InfraAuthError } from "./http.js";

const SERVER = {
  id: 42,
  name: "CABIOMASTER",
  status: "running",
  created: "2026-05-20T10:00:00+00:00",
  server_type: {
    name: "cpx32",
    prices: [
      {
        location: "fsn1",
        price_hourly: { net: "0.0569000000" },
        price_monthly: { net: "35.4900000000" },
        included_traffic: 21990232555520,
        price_per_tb_traffic: { net: "1.0000000000" },
      },
    ],
  },
  location: { name: "fsn1" },
  public_net: { ipv4: { ip: "178.105.149.221" } },
  protection: { delete: true },
  backup_window: "22-02",
  included_traffic: 21990232555520,
  outgoing_traffic: 6_800_000_000,
  volumes: [],
};

function stubFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("hetznerClient", () => {
  it("maps a server, reading location from server.location, prices as cents", async () => {
    const f = stubFetch({ servers: [SERVER], meta: { pagination: { next_page: null } } });
    const [s] = await hetznerClient("tok", { fetch: f }).listServers();
    expect(s).toMatchObject({ id: 42, name: "CABIOMASTER", location: "fsn1", ipv4: "178.105.149.221", deleteProtected: true, backupsEnabled: true });
    expect(s!.price).toEqual({ hourlyMicroCents: 5_690_000, monthlyCents: 3549, perTbTrafficCents: 100 });
    expect(f).toHaveBeenCalledWith(expect.stringContaining("/servers?per_page=50&page=1"), expect.anything());
  });

  it("throws InfraAuthError on 401 without leaking the token", async () => {
    const err = await hetznerClient("secret-token", { fetch: stubFetch({}, 401) }).listServers().catch((e) => e);
    expect(err).toBeInstanceOf(InfraAuthError);
    expect(String(err.message)).not.toContain("secret-token");
  });

  it("follows pagination", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [SERVER], meta: { pagination: { next_page: 2 } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [{ ...SERVER, id: 43 }], meta: { pagination: { next_page: null } } })));
    expect(await hetznerClient("tok", { fetch: f }).listServers()).toHaveLength(2);
  });

  it("uses the mock for mock_ tokens", async () => {
    expect((await hetznerClient("mock_x").listServers()).length).toBeGreaterThan(0);
  });

  it("mock runAction returns a running action that settles to success", async () => {
    const c = mockHetznerClient();
    const a = await c.runAction(1, "reboot");
    expect(a.status).toBe("running");
    expect((await c.getAction(a.id)).status).toBe("success");
  });

  it("parses Hetzner decimal strings to cents exactly", () => {
    expect(eurCents("35.4900000000")).toBe(3549);
    expect(eurCents("0.5000000000")).toBe(50);
    expect(eurCents("5.4950000000")).toBe(550);
  });
});
