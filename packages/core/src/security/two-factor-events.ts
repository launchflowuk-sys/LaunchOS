import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";

/**
 * The five things that can happen to somebody's second factor and are worth
 * keeping. A successful challenge is deliberately not among them: it happens
 * on every sign-in and would bury the four that matter.
 */
export const TWO_FACTOR_EVENTS = [
  "enabled",
  "disabled",
  "backup_codes_regenerated",
  "backup_code_used",
  "challenge_failed",
] as const;
export type TwoFactorEvent = (typeof TWO_FACTOR_EVENTS)[number];

/** The events that are not just filed but announced. */
const ANNOUNCED: ReadonlySet<TwoFactorEvent> = new Set<TwoFactorEvent>(["disabled", "backup_code_used"]);

export const RecordTwoFactorEventInput = z.object({
  userId: z.string().min(1),
  event: z.enum(TWO_FACTOR_EVENTS),
  /** Whose second factor it was, as far as the sign-in surface is concerned. */
  ip: z.string().trim().max(120).nullish(),
  userAgent: z.string().trim().max(500).nullish(),
});
export type RecordTwoFactorEventInput = z.input<typeof RecordTwoFactorEventInput>;

export type TwoFactorEventResult = {
  organisationId: string;
  actorKind: "user" | "client";
  action: string;
};

type Subject = { organisationId: string; actorKind: "user" | "client"; label: string };

/**
 * Which organisation a `user` row belongs to, and in what capacity.
 *
 * Staff first, for the same reason `/after-sign-in` puts them first: a person
 * who somehow holds both kinds of membership is the more privileged of the
 * two, and their events belong on the organisation that grants that. Neither
 * lookup filters on status — access that has just been revoked is exactly when
 * a security event is most worth recording, and a suspended member whose
 * second factor is being turned off must not fall silently off the log.
 */
async function resolveSubject(db: Db, userId: string): Promise<Subject | null> {
  const [row] = await db
    .select({ organisationId: schema.organisationMembers.organisationId, name: schema.user.email })
    .from(schema.organisationMembers)
    .innerJoin(schema.user, eq(schema.organisationMembers.userId, schema.user.id))
    .where(eq(schema.organisationMembers.userId, userId))
    .orderBy(asc(schema.organisationMembers.createdAt))
    .limit(1);
  if (row) return { organisationId: row.organisationId, actorKind: "user", label: row.name };

  const [portal] = await db
    .select({ organisationId: schema.clientUsers.organisationId, name: schema.user.email })
    .from(schema.clientUsers)
    .innerJoin(schema.user, eq(schema.clientUsers.userId, schema.user.id))
    .where(eq(schema.clientUsers.userId, userId))
    .orderBy(asc(schema.clientUsers.createdAt))
    .limit(1);
  if (portal) return { organisationId: portal.organisationId, actorKind: "client", label: portal.name };

  return null;
}

const HEADLINES: Record<TwoFactorEvent, string> = {
  enabled: "Two-factor authentication switched on",
  disabled: "Two-factor authentication switched off",
  backup_codes_regenerated: "Two-factor backup codes replaced",
  backup_code_used: "A two-factor backup code was used",
  challenge_failed: "A two-factor code was rejected",
};

/**
 * Files one two-factor security event against the user it happened to, and
 * announces the two that should interrupt somebody.
 *
 * Called from the auth layer's own after-hook rather than from a form
 * handler, so it records what Better Auth actually did — a client that skips
 * the screen and posts straight at `/api/auth` is recorded the same way.
 *
 * Nothing here ever carries a code, a secret or a backup code: the audit row
 * holds the event name, the address and the browser string, and the
 * notification holds the account's email address. `recordAudit`'s `after`
 * is the whole payload, so anything put in it is readable by every owner.
 *
 * Returns null for a `user` row that belongs to no organisation at all. That
 * is not a silent failure to hide: `audit_log.organisation_id` is the tenancy
 * key and there is no honest value for it, so the caller logs instead.
 */
export async function recordTwoFactorEvent(
  db: Db,
  input: RecordTwoFactorEventInput,
): Promise<TwoFactorEventResult | null> {
  const v = RecordTwoFactorEventInput.parse(input);
  const subject = await resolveSubject(db, v.userId);
  if (!subject) return null;

  const action = `security.two_factor_${v.event}`;
  await recordAudit(db, subject.organisationId, {
    actorKind: subject.actorKind,
    actorId: v.userId,
    action,
    targetType: "user",
    targetId: v.userId,
    after: {
      event: v.event,
      account: subject.label,
      ip: v.ip ?? null,
      userAgent: v.userAgent ?? null,
    },
  });

  if (ANNOUNCED.has(v.event)) {
    await notifyOwner(db, subject.organisationId, {
      kind: action,
      title: HEADLINES[v.event],
      body:
        v.event === "disabled"
          ? `${subject.label} no longer has a second factor on their account. If that was not them, change the password and switch it back on.`
          : `${subject.label} signed in with a single-use backup code. That code is now spent — replace the set if the authenticator is gone.`,
      link: "/account",
    });
  }

  return { organisationId: subject.organisationId, actorKind: subject.actorKind, action };
}

/**
 * True when this user holds a staff membership — the audience the
 * organisation's `require_staff_two_factor` switch applies to. Portal users
 * are never covered by it.
 */
export async function isStaffUser(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.organisationMembers.id })
    .from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.userId, userId), eq(schema.organisationMembers.status, "active")))
    .limit(1);
  return !!row;
}
