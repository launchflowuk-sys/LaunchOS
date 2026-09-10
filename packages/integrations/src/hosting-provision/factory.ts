import { HostingerProvisioner } from "./hostinger.js";
import { MockHostingProvisioner } from "./mock.js";
import type { HostingProvisioner } from "./types.js";

/**
 * Mock unless `HOSTINGER_API_TOKEN` is set — mock-first, per rule 4.
 *
 * The same token the registrar sync and the cost sync already use. There is
 * nothing extra to configure: if domains and costs are syncing, provisioning
 * has what it needs.
 */
export function createHostingProvisionerFromEnv(env: NodeJS.ProcessEnv = process.env): HostingProvisioner {
  const apiToken = env.HOSTINGER_API_TOKEN?.trim();
  if (!apiToken) return new MockHostingProvisioner();
  return new HostingerProvisioner({ apiToken });
}
