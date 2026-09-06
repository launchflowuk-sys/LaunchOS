import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TelemetrySnapshot } from "./telemetry.js";

/**
 * `GET /health` for Coolify's health check and anyone wondering whether the
 * worker is alive. 200 once pg-boss is started and every handler is
 * registered; 503 before that, so a deploy that dies during boot is marked
 * unhealthy rather than "starting" for ever. The body is the telemetry
 * snapshot — counters and timestamps, nothing from a job payload.
 */

export interface HealthStatus extends TelemetrySnapshot {
  /** True once pg-boss is started and the handlers are registered. */
  ready: boolean;
}

export interface HealthBody extends TelemetrySnapshot {
  ok: boolean;
}

export interface HealthServerOptions {
  /** `0` asks the OS for a free port (tests). */
  readonly port: number;
  readonly status: () => HealthStatus;
  readonly logger?: Pick<Console, "info" | "error">;
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

export const HEALTH_PATH = "/health";

/** The response for one status, exported so the shape is testable without a socket. */
export function healthResponse(status: HealthStatus): { statusCode: number; body: HealthBody } {
  const { ready, ...snapshot } = status;
  return { statusCode: ready ? 200 : 503, body: { ok: ready, ...snapshot } };
}

export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const logger = options.logger ?? console;
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path !== HEALTH_PATH && path !== "/") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "application/json", allow: "GET, HEAD" });
      response.end(JSON.stringify({ ok: false, error: "method not allowed" }));
      return;
    }
    const { statusCode, body } = healthResponse(options.status());
    response.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify(body));
  });
  server.on("error", (error) => logger.error("worker health server error", error));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  logger.info({ port, path: HEALTH_PATH }, "worker health endpoint listening");
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
