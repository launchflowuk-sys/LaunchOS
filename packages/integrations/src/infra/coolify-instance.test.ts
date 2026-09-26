import { describe, expect, it, vi } from "vitest";
import { coolifyInstanceClient } from "./coolify-instance.js";

const route = (map: Record<string, unknown>) =>
  vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    const body = map[path];
    return new Response(typeof body === "string" ? body : JSON.stringify(body ?? []), { status: body === undefined ? 404 : 200 });
  });

describe("coolifyInstanceClient", () => {
  it("reads version as text", async () => {
    const c = coolifyInstanceClient("http://1.2.3.4:8000", "7|abc", { fetch: route({ "/version": "4.3.23" }) as never });
    expect(await c.version()).toBe("4.3.23");
  });

  it("merges apps, databases and services and splits status into state/health", async () => {
    const f = route({
      "/applications": [{ uuid: "a1", name: "moodera-backend", status: "exited:unhealthy", fqdn: "https://x.test" }],
      "/databases": [{ uuid: "d1", name: "moodera-postgres", status: "running:healthy" }],
      "/services": [],
    });
    const rs = await coolifyInstanceClient("http://1.2.3.4:8000/", "t", { fetch: f as never }).resources();
    expect(rs).toEqual([
      { uuid: "a1", name: "moodera-backend", kind: "application", state: "exited", health: "unhealthy", fqdn: "https://x.test" },
      { uuid: "d1", name: "moodera-postgres", kind: "database", state: "running", health: "healthy", fqdn: null },
    ]);
  });

  it("deploys by POSTing to /deploy?uuid=", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ deployments: [{ deployment_uuid: "dep1" }] })));
    const out = await coolifyInstanceClient("http://h:8000", "t", { fetch: f as never }).deploy("a1");
    expect(f.mock.calls[0]![0]).toBe("http://h:8000/api/v1/deploy?uuid=a1");
    expect(f.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    expect(out.deploymentUuid).toBe("dep1");
  });
});
