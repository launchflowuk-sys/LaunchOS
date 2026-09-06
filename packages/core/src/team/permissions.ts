import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { MemberPermissions } from "@launchos/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export type { MemberPermissions };

/** Every area a permission gates, in the order the Team screen lists them. */
export const PERMISSION_KEYS = ["support", "content", "billing", "settings", "approvals", "access"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_LABELS: Readonly<Record<PermissionKey, string>> = {
  support: "Support — cases and the inbox",
  content: "Content — briefs, calendar and posts",
  billing: "Billing — invoices, subscriptions and packages",
  settings: "Settings — organisation, team, agents and email",
  approvals: "Approvals — deciding what the agents queue",
  access: "Access — revealing and editing the passwords in a client's access vault",
};

type MemberRole = "owner" | "staff";

/**
 * What a member may do before anyone has edited them: an owner may do
 * everything, and a staff member everything except change the organisation's
 * settings — which is where members, agents and email live, and the one area
 * that should take a deliberate grant.
 *
 * `access` — the client vault's passwords — is on for staff by default: the
 * vault exists so the team can get onto a client's server without asking, and
 * every reveal is recorded against the person who made it. An owner who wants
 * it narrower unticks it on the Team screen.
 */
export function defaultPermissions(role: MemberRole): MemberPermissions {
  return {
    support: true,
    content: true,
    billing: true,
    settings: role === "owner",
    approvals: true,
    access: true,
  };
}

/**
 * The permissions a member actually has. An owner resolves to all six
 * whatever is stored — the stored object is never consulted — so nobody can
 * lock the owner out of Settings by editing a jsonb column. A staff member
 * gets the default with whatever has been stored laid over it, key by key, so
 * a permission added later reads as its default for everyone until somebody
 * changes it.
 */
export function resolvePermissions(role: MemberRole, stored: Partial<MemberPermissions> | null | undefined): MemberPermissions {
  const defaults = defaultPermissions(role);
  if (role === "owner") return defaults;
  const overlay = Object.fromEntries(
    PERMISSION_KEYS.filter((key) => typeof stored?.[key] === "boolean").map((key) => [key, stored![key]]),
  );
  return { ...defaults, ...overlay };
}

export const GetMemberPermissionsInput = z.object({ userId: z.string().min(1) });
export type GetMemberPermissionsInput = z.input<typeof GetMemberPermissionsInput>;

export interface MemberPermissionsRow {
  memberId: string;
  userId: string;
  role: MemberRole;
  status: "active" | "invited" | "suspended";
  /** What the member actually has. */
  permissions: MemberPermissions;
  /** What is stored on the row; null when the role default applies. */
  stored: Partial<MemberPermissions> | null;
}

/** The member's resolved permissions, or null when they are not a member of this organisation. */
export async function getMemberPermissions(db: Db, organisationId: string, input: GetMemberPermissionsInput): Promise<MemberPermissionsRow | null> {
  const v = GetMemberPermissionsInput.parse(input);
  const [row] = await db
    .select({
      memberId: schema.organisationMembers.id,
      userId: schema.organisationMembers.userId,
      role: schema.organisationMembers.role,
      status: schema.organisationMembers.status,
      stored: schema.organisationMembers.permissions,
    })
    .from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.userId, v.userId)))
    .limit(1);
  if (!row) return null;
  return { ...row, permissions: resolvePermissions(row.role, row.stored) };
}

export const SetMemberPermissionsInput = z.object({
  memberId: z.string().uuid(),
  permissions: z.object({
    support: z.boolean().optional(),
    content: z.boolean().optional(),
    billing: z.boolean().optional(),
    settings: z.boolean().optional(),
    approvals: z.boolean().optional(),
    access: z.boolean().optional(),
  }),
  actorId: z.string().min(1),
});
export type SetMemberPermissionsInput = z.input<typeof SetMemberPermissionsInput>;

/**
 * Stores a staff member's permissions. The stored object is the whole
 * resolved set, not a diff: what the Team screen shows after the save is
 * exactly what was saved, and `resolvePermissions` has nothing to guess at.
 *
 * Refused for an owner: an owner always has every permission, and storing a
 * narrower set would show a form that lies about what they can do.
 */
export async function setMemberPermissions(db: Db, organisationId: string, input: SetMemberPermissionsInput): Promise<MemberPermissionsRow> {
  const v = SetMemberPermissionsInput.parse(input);
  const [member] = await db
    .select({
      id: schema.organisationMembers.id,
      userId: schema.organisationMembers.userId,
      role: schema.organisationMembers.role,
      status: schema.organisationMembers.status,
      stored: schema.organisationMembers.permissions,
    })
    .from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.id, v.memberId), eq(schema.organisationMembers.organisationId, organisationId)))
    .limit(1);
  if (!member) throw new Error(`member ${v.memberId} not found in organisation`);
  if (member.role === "owner") throw new Error("an owner always has every permission; they cannot be narrowed");

  const before = resolvePermissions(member.role, member.stored);
  const after = { ...before, ...stripUndefined(v.permissions) };

  const [row] = await db
    .update(schema.organisationMembers)
    .set({ permissions: after, updatedAt: new Date() })
    .where(and(eq(schema.organisationMembers.id, v.memberId), eq(schema.organisationMembers.organisationId, organisationId)))
    .returning({ id: schema.organisationMembers.id });
  if (!row) throw new Error(`member ${v.memberId} not found in organisation`);

  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: v.actorId,
    action: "member.permissions_updated",
    targetType: "organisation_member",
    targetId: member.id,
    before,
    after,
  });
  return { memberId: member.id, userId: member.userId, role: member.role, status: member.status, permissions: after, stored: after };
}

function stripUndefined(input: { [K in PermissionKey]?: boolean | undefined }): Partial<MemberPermissions> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<MemberPermissions>;
}

/** Thrown by `assertPermission`; the web layer turns it into a 403 or a plain sentence. */
export class PermissionDenied extends Error {
  constructor(public readonly key: PermissionKey, message = `You do not have the ${key} permission`) {
    super(message);
    this.name = "PermissionDenied";
  }
}

/** True when the user is an active member with `key`. Never throws for a stranger: they simply have nothing. */
export async function hasPermission(db: Db, organisationId: string, userId: string, key: PermissionKey): Promise<boolean> {
  const member = await getMemberPermissions(db, organisationId, { userId });
  return member?.status === "active" && member.permissions[key];
}

/**
 * The guard a server action calls before it does anything gated: throws
 * `PermissionDenied` unless the user is an active member holding `key`.
 * Returns the resolved set so a caller that needs to check two things does
 * not read the row twice.
 */
export async function assertPermission(db: Db, organisationId: string, userId: string, key: PermissionKey): Promise<MemberPermissions> {
  const member = await getMemberPermissions(db, organisationId, { userId });
  if (!member || member.status !== "active") throw new PermissionDenied(key, "You are not an active member of this organisation");
  if (!member.permissions[key]) throw new PermissionDenied(key);
  return member.permissions;
}
