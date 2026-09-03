export interface HostingResources {
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  lastDeployAt: string;
  status: "running" | "exited" | "restarting";
}

export interface HostingProvider {
  getResources(ref: string): Promise<HostingResources>;
}

export class MockHostingProvider implements HostingProvider {
  constructor(private readonly overrides: Record<string, Partial<HostingResources>> = {}) {}

  async getResources(ref: string): Promise<HostingResources> {
    return {
      cpuPercent: 12,
      memoryPercent: 41,
      diskPercent: 55,
      lastDeployAt: "2026-09-01T09:00:00Z",
      status: "running",
      ...this.overrides[ref],
    };
  }
}
