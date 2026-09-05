import { describe, expect, it } from "vitest";
import {
  HostingAuthError,
  HostingRefNotFound,
  MockHostingProvider,
  type HostingProvider,
  type HostingResources,
} from "@launchos/integrations";
import type { AgentContext } from "../kernel/types.js";
import { hostingGetResources } from "./hosting-get-resources.js";

/** The tool never reads its context; the type is what the kernel demands. */
const ctx = {} as AgentContext;

/** A provider that throws a chosen error for every ref. */
function throwing(error: Error): HostingProvider {
  return {
    name: "coolify",
    async getResources(): Promise<HostingResources> {
      throw error;
    },
    async restart() {
      throw new Error("not under test");
    },
    async listApplications() {
      return [];
    },
  };
}

describe("hosting_get_resources", () => {
  it("returns the resources, flagged found, when the provider knows the ref", async () => {
    const tool = hostingGetResources(new MockHostingProvider({ app_1: { status: "exited", cpuPercent: 97 } }));
    const out = await tool.execute({ hostingRef: "app_1" }, ctx);
    expect(out).toMatchObject({ found: true, status: "exited", cpuPercent: 97 });
  });

  it("turns HostingRefNotFound into a structured result instead of failing the run", async () => {
    // A mistyped `sites.hosting_ref` is the one error that is about the ref,
    // not the deployment: the Guard-Dog can still file its ticket saying so.
    const tool = hostingGetResources(throwing(new HostingRefNotFound("app_typo")));
    const out = await tool.execute({ hostingRef: "app_typo" }, ctx);
    expect(out.found).toBe(false);
    if (out.found) throw new Error("unreachable");
    expect(out.hostingRef).toBe("app_typo");
    expect(out.reason).toMatch(/app_typo/);
  });

  it("lets every other provider error propagate", async () => {
    // A bad token is configuration, not a sick site; the run should fail loudly.
    const tool = hostingGetResources(throwing(new HostingAuthError(401)));
    await expect(tool.execute({ hostingRef: "app_1" }, ctx)).rejects.toBeInstanceOf(HostingAuthError);
  });
});
