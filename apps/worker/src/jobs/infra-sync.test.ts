import { describe, expect, it, vi } from "vitest";
import { handleInfraSync } from "./infra-sync.js";

describe("handleInfraSync", () => {
  it("logs a summary and never throws when a connection failed", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Console;
    const sync = vi.fn(async () => ({ servers: 3, connections: [{ label: "A", ok: true }, { label: "B", ok: false, error: "401" }] }));
    const out = await handleInfraSync({ db: {} as never, logger, sync }, { organisationId: "o1" });
    expect(out.servers).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith("[infra.sync] connection failed", { organisationId: "o1", label: "B", error: "401" });
  });
});
