import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_PATH, healthResponse, startHealthServer, type HealthServer, type HealthStatus } from "./health.js";
import { WorkerTelemetry } from "./telemetry.js";

const quiet = { info() {}, error() {} };
let server: HealthServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("healthResponse", () => {
  it("is 200 { ok: true } once ready and 503 { ok: false } before, carrying the snapshot either way", () => {
    const snapshot = new WorkerTelemetry().snapshot();
    const ready = healthResponse({ ready: true, ...snapshot });
    expect(ready.statusCode).toBe(200);
    expect(ready.body).toEqual({ ok: true, ...snapshot });
    const booting = healthResponse({ ready: false, ...snapshot });
    expect(booting.statusCode).toBe(503);
    expect(booting.body.ok).toBe(false);
  });
});

describe("startHealthServer", () => {
  it("answers GET /health from the live status, 404 elsewhere, 405 for a POST", async () => {
    const telemetry = new WorkerTelemetry();
    let ready = false;
    const status = (): HealthStatus => ({ ready, ...telemetry.snapshot() });
    server = await startHealthServer({ port: 0, status, logger: quiet });
    expect(server.port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${server.port}`;

    const booting = await fetch(`${base}${HEALTH_PATH}`);
    expect(booting.status).toBe(503);
    expect(booting.headers.get("cache-control")).toBe("no-store");
    expect(await booting.json()).toMatchObject({ ok: false, lastJobAt: null, queues: {} });

    ready = true;
    telemetry.jobSucceeded("monitor.check");
    const live = await fetch(`${base}/health?probe=coolify`);
    expect(live.status).toBe(200);
    const body = await live.json() as { ok: boolean; uptime: number; lastJobAt: string; queues: Record<string, { runs: number }> };
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe("number");
    expect(body.lastJobAt).toMatch(/^\d{4}-/);
    expect(body.queues["monitor.check"]!.runs).toBe(1);

    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/anything-else`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(405);
    const head = await fetch(`${base}/health`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});
