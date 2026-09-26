import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { CoolifyResource } from "@launchos/integrations";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { COST_BUSINESSES, type CostBusiness } from "../costs/register.js";
import { connectionSecret, coolifyFor, hetznerFor, type InfraDeps } from "./connections.js";

export const SERVER_COMMANDS = ["reboot", "shutdown", "poweron", "create_image", "enable_backup", "disable_backup"] as const;
export type ServerCommand = (typeof SERVER_COMMANDS)[number];
/** These take a running site offline; the person types the server's name to confirm. */
const NAMED = new Set<ServerCommand>(["reboot", "shutdown"]);

const RunInput = z.object({ serverId: z.string().uuid(), command: z.enum(SERVER_COMMANDS), confirmName: z.string().optional(), actorId: z.string().min(1) });

async function ownedServer(db: Db, organisationId: string, serverId: string) {
  const [s] = await db.select().from(schema.servers).where(and(eq(schema.servers.organisationId, organisationId), eq(schema.servers.id, serverId)));
  if (!s) throw new Error("Server not found.");
  return s;
}

/**
 * Reboot/shutdown/etc a real server. Two quick clicks must not both reach
 * Hetzner: the row is claimed with a conditional update (only when
 * `pending_action` is still null) before the provider is called at all, so a
 * second concurrent call sees the claim and refuses rather than racing it.
 * If Hetzner then rejects the action, the claim is released so the server
 * is not stuck "busy" forever, and nothing is audited — only an action
 * Hetzner actually accepted is recorded.
 */
export async function runServerAction(db: Db, organisationId: string, raw: z.input<typeof RunInput>, deps: InfraDeps & { now?: Date } = {}) {
  const input = RunInput.parse(raw);
  const server = await ownedServer(db, organisationId, input.serverId);
  if (NAMED.has(input.command) && input.confirmName?.trim() !== server.name) throw new Error(`Type the server name "${server.name}" to confirm.`);

  const now = deps.now ?? new Date();
  const [claimed] = await db
    .update(schema.servers)
    .set({ pendingAction: { id: 0, command: input.command, startedAt: now.toISOString() }, updatedAt: now })
    .where(and(eq(schema.servers.id, server.id), eq(schema.servers.organisationId, organisationId), isNull(schema.servers.pendingAction)))
    .returning();
  if (!claimed) throw new Error(`${server.name} already has an action in progress — wait for it to finish.`);

  let action;
  try {
    const client = hetznerFor(deps, await connectionSecret(db, organisationId, server.connectionId, deps.env));
    const description = input.command === "create_image" ? `LaunchOS ${now.toISOString().slice(0, 16)}` : undefined;
    action = await client.runAction(server.hetznerId, input.command, description);
  } catch (error) {
    await db.update(schema.servers).set({ pendingAction: null }).where(eq(schema.servers.id, server.id));
    throw error;
  }

  await db.update(schema.servers)
    .set({ pendingAction: { id: action.id, command: input.command, startedAt: now.toISOString() }, updatedAt: now })
    .where(eq(schema.servers.id, server.id));
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: `infra.server.${input.command}`, targetType: "server", targetId: server.id,
    after: { name: server.name, hetznerId: server.hetznerId, hetznerActionId: action.id },
  });
  return { actionId: action.id };
}

export async function setServerBusiness(db: Db, organisationId: string, input: { serverId: string; business: CostBusiness; actorId: string }) {
  const business = z.enum(COST_BUSINESSES).parse(input.business);
  const server = await ownedServer(db, organisationId, input.serverId);
  if (server.business === business) return;
  await db.update(schema.servers).set({ business, updatedAt: new Date() }).where(eq(schema.servers.id, server.id));
  await db.update(schema.supplierCosts).set({ business })
    .where(and(eq(schema.supplierCosts.organisationId, organisationId), eq(schema.supplierCosts.supplier, "hetzner"),
      eq(schema.supplierCosts.externalId, `${server.connectionId}:${server.hetznerId}`)));
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: "infra.server.business", targetType: "server", targetId: server.id,
    before: { business: server.business }, after: { business },
  });
}

export async function redeployApp(db: Db, organisationId: string, input: { connectionId: string; appUuid: string; appName: string; actorId: string }, deps: InfraDeps = {}) {
  const [conn] = await db.select().from(schema.infraConnections)
    .where(and(eq(schema.infraConnections.organisationId, organisationId), eq(schema.infraConnections.id, input.connectionId), eq(schema.infraConnections.provider, "coolify")));
  if (!conn?.baseUrl) throw new Error("Coolify connection not found.");
  const out = await coolifyFor(deps, conn.baseUrl, await connectionSecret(db, organisationId, conn.id, deps.env)).deploy(input.appUuid);
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: "infra.app.redeploy", targetType: "infra_connection", targetId: conn.id,
    after: { appUuid: input.appUuid, appName: input.appName, deploymentUuid: out.deploymentUuid },
  });
  return out;
}

export type ServerView = typeof schema.servers.$inferSelect & {
  accountLabel: string;
  coolify: { id: string; label: string; baseUrl: string } | null;
};

export async function listServers(db: Db, organisationId: string): Promise<ServerView[]> {
  const [rows, conns] = await Promise.all([
    db.select().from(schema.servers).where(eq(schema.servers.organisationId, organisationId)).orderBy(asc(schema.servers.name)),
    db.select().from(schema.infraConnections).where(eq(schema.infraConnections.organisationId, organisationId)),
  ]);
  const byId = new Map(conns.map((c) => [c.id, c]));
  return rows.map((s) => {
    const cf = conns.find((c) => c.provider === "coolify" && c.serverId === s.id && c.baseUrl);
    return { ...s, accountLabel: byId.get(s.connectionId)?.label ?? "?", coolify: cf ? { id: cf.id, label: cf.label, baseUrl: cf.baseUrl! } : null };
  });
}

/** Live, per page load, 5 s budget each. Failure is a value, not a throw — one dead Coolify must not break the screen. */
export async function coolifyResourcesFor(db: Db, organisationId: string, connectionId: string, deps: InfraDeps = {}):
  Promise<{ ok: true; resources: CoolifyResource[] } | { ok: false; message: string }> {
  try {
    const [conn] = await db.select().from(schema.infraConnections)
      .where(and(eq(schema.infraConnections.organisationId, organisationId), eq(schema.infraConnections.id, connectionId)));
    if (!conn?.baseUrl) return { ok: false, message: "not linked" };
    return { ok: true, resources: await coolifyFor(deps, conn.baseUrl, await connectionSecret(db, organisationId, conn.id, deps.env)).resources() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "unreachable" };
  }
}
