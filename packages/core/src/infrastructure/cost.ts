import type { ServerCost } from "@launchos/db/schema";
import type { HetznerImage, HetznerPricing, HetznerPrimaryIp, HetznerServer, HetznerVolume } from "@launchos/integrations";

const HOUR = 3_600_000;
const TIB = 1024 ** 4;

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * What one server costs this month, in EUR cents, net — Hetzner's list prices
 * applied the way Hetzner bills: hourly until the monthly cap. Add-ons are
 * monthly and prorated with the same fraction as the base, so month-to-date
 * and projected stay consistent.
 *
 * ponytail: list prices, not the invoice — Hetzner's API has no invoices.
 */
export function serverCost(input: {
  server: HetznerServer; volumes: HetznerVolume[]; primaryIps: HetznerPrimaryIp[]; snapshots: HetznerImage[];
  pricing: HetznerPricing; now: Date;
}): ServerCost {
  const { server, pricing, now } = input;
  const from = Math.max(monthStart(now).getTime(), server.createdAt.getTime());
  const hours = Math.max(0, Math.ceil((now.getTime() - from) / HOUR));
  const monthly = server.price.monthlyCents;
  const base = Math.min(Math.round((hours * server.price.hourlyMicroCents) / 1_000_000), monthly);
  const fraction = monthly === 0 ? 0 : base / monthly;

  const backups = server.backupsEnabled ? Math.round((monthly * pricing.backupPercent) / 100) : 0;
  const volumes = Math.round(input.volumes.filter((v) => v.serverId === server.id).reduce((a, v) => a + v.sizeGb * pricing.volumeMilliCentsPerGbMonth, 0) / 1000);
  const primaryIps = input.primaryIps.filter((p) => p.assigneeId === server.id && p.type === "ipv4").length * (pricing.primaryIpv4MonthlyCents[server.location] ?? 0);
  const snapshots = Math.round(input.snapshots.filter((s) => s.createdFrom === server.id).reduce((a, s) => a + s.sizeGb * pricing.imageMilliCentsPerGbMonth, 0) / 1000);
  const overBytes = Math.max(0, server.outgoingTrafficBytes - server.includedTrafficBytes);
  const traffic = Math.round((overBytes / TIB) * server.price.perTbTrafficCents);

  const addOns = backups + volumes + primaryIps + snapshots;
  return {
    base, backups, volumes, primaryIps, snapshots, traffic,
    monthToDate: base + Math.round(addOns * fraction) + traffic,
    projectedMonth: monthly + addOns + traffic,
  };
}
