import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { isValidTimeZone } from "./time.js";

/** `organisations.metadata.booking` — no column, no migration. */
export const BOOKING_METADATA_KEY = "booking";

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
/** One open window on a day: `["13:00", "23:00"]`. End after start; `24:00` is not a time — use `23:59`. */
const Window = z.tuple([Time, Time]).refine(([from, to]) => from < to, "a window must end after it starts");

const Windows = z.array(Window).max(4).default([]);
const Hours = z.object({ mon: Windows, tue: Windows, wed: Windows, thu: Windows, fri: Windows, sat: Windows, sun: Windows });

export const BookingSettingsSchema = z.object({
  timezone: z.string().refine(isValidTimeZone, "not an IANA timezone").default("Europe/London"),
  slotMinutes: z.number().int().min(10).max(240).default(30),
  bufferMinutes: z.number().int().min(0).max(120).default(15),
  hours: Hours.default({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }),
  horizonDays: z.number().int().min(1).max(90).default(21),
  minNoticeHours: z.number().int().min(0).max(168).default(12),
  /** The staff user whose diary this is. Null → the organisation's owner. */
  hostUserId: z.string().min(1).nullable().default(null),
});
export type BookingSettings = z.infer<typeof BookingSettingsSchema>;
export type BookingHours = BookingSettings["hours"];
export type BookingWindow = z.infer<typeof Window>;

/**
 * Shoji's hours: 13:00–23:00 London, Monday to Saturday, 30-minute slots, a
 * quarter-hour between calls, three weeks out, half a day's notice. The
 * timezone stays London whatever country he is in, so the hours follow UK
 * clients (in Pakistan that is 17:00–03:00 local, which suits him).
 */
export const DEFAULT_BOOKING_SETTINGS: BookingSettings = BookingSettingsSchema.parse({
  timezone: "Europe/London",
  slotMinutes: 30,
  bufferMinutes: 15,
  hours: {
    mon: [["13:00", "23:00"]], tue: [["13:00", "23:00"]], wed: [["13:00", "23:00"]],
    thu: [["13:00", "23:00"]], fri: [["13:00", "23:00"]], sat: [["13:00", "23:00"]], sun: [],
  },
  horizonDays: 21,
  minNoticeHours: 12,
  hostUserId: null,
});

/** The settings an organisation carries, defaults filled in; a corrupt value reads as the defaults. */
export function bookingSettingsFrom(metadata: Record<string, unknown> | null | undefined): BookingSettings {
  const raw = metadata?.[BOOKING_METADATA_KEY];
  if (!raw || typeof raw !== "object") return DEFAULT_BOOKING_SETTINGS;
  const parsed = BookingSettingsSchema.safeParse({ ...DEFAULT_BOOKING_SETTINGS, ...(raw as Record<string, unknown>) });
  return parsed.success ? parsed.data : DEFAULT_BOOKING_SETTINGS;
}

export async function getBookingSettings(db: Db, organisationId: string): Promise<BookingSettings> {
  const [org] = await db.select({ metadata: schema.organisations.metadata }).from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  if (!org) throw new Error(`organisation ${organisationId} not found`);
  return bookingSettingsFrom(org.metadata);
}

/** The oldest active owner — the diary every meeting is booked into unless `hostUserId` says otherwise. */
export async function defaultHostUserId(db: Db, organisationId: string): Promise<string | null> {
  const [owner] = await db.select({ userId: schema.organisationMembers.userId }).from(schema.organisationMembers)
    .where(and(
      eq(schema.organisationMembers.organisationId, organisationId),
      eq(schema.organisationMembers.role, "owner"),
      eq(schema.organisationMembers.status, "active"),
    ))
    .orderBy(asc(schema.organisationMembers.createdAt))
    .limit(1);
  return owner?.userId ?? null;
}

/** The settings plus the resolved host; throws when the organisation has nobody to host. */
export async function resolveBookingHost(db: Db, organisationId: string): Promise<{ settings: BookingSettings; hostUserId: string }> {
  const settings = await getBookingSettings(db, organisationId);
  const hostUserId = settings.hostUserId ?? (await defaultHostUserId(db, organisationId));
  if (!hostUserId) throw new Error("this organisation has no owner to host calls");
  return { settings, hostUserId };
}

export const SetBookingSettingsInput = z.object({
  settings: BookingSettingsSchema.partial(),
  actorId: z.string().min(1),
});
export type SetBookingSettingsInput = z.input<typeof SetBookingSettingsInput>;

/** Merges a partial update over the current settings; audited as `organisation.booking_updated`. */
export async function setBookingSettings(db: Db, organisationId: string, input: SetBookingSettingsInput): Promise<BookingSettings> {
  const v = SetBookingSettingsInput.parse(input);
  const before = await getBookingSettings(db, organisationId);
  if (v.settings.hostUserId) {
    const [member] = await db.select({ id: schema.organisationMembers.id }).from(schema.organisationMembers)
      .where(and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.userId, v.settings.hostUserId),
        eq(schema.organisationMembers.status, "active"),
      ))
      .limit(1);
    if (!member) throw new Error(`host ${v.settings.hostUserId} is not an active member of this organisation`);
  }
  const after = BookingSettingsSchema.parse({ ...before, ...v.settings });
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.update(schema.organisations)
      .set({
        metadata: sql`coalesce(${schema.organisations.metadata}, '{}'::jsonb) || ${JSON.stringify({ [BOOKING_METADATA_KEY]: after })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(schema.organisations.id, organisationId));
    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "organisation.booking_updated",
      targetType: "organisation", targetId: organisationId, before, after,
    });
    return after;
  });
}
