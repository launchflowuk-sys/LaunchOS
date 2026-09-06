import { randomUUID } from "node:crypto";
import { bookMeeting, cancelMeeting } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockMeetingsAdapter } from "@launchos/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";

let currentDb: Db | undefined;
vi.mock("@/lib/db", () => ({ getDb: () => currentDb! }));

import { GET } from "./route.js";

/** Monday 7 Sep 2026, 10:00Z; with the default 12 h notice the first bookable slot is Tuesday 13:00 BST. */
const NOW = new Date("2026-09-07T10:00:00Z");
const TUE_13 = new Date("2026-09-08T12:00:00Z");

/** An organisation with an owner — `resolveBookingHost` needs one to host the call. */
async function seed(db: Db): Promise<string> {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `ics-route-${randomUUID()}` }).returning();
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Shoji Owner", email: `o-${userId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId, role: "owner", status: "active" });
  return org!.id;
}

function get(token: string): Promise<Response> {
  return GET(new Request(`http://localhost/book/r/${token}/calendar.ics`), { params: Promise.resolve({ token }) });
}

describe("GET /book/r/[token]/calendar.ics", () => {
  afterEach(() => {
    currentDb = undefined;
  });

  it("serves the meeting as text/calendar by its token, as a REQUEST, and as a CANCEL once cancelled", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const organisationId = await seed(db);
      const meetings = new MockMeetingsAdapter();
      const { meeting } = await bookMeeting(
        db,
        organisationId,
        { guestName: "Aisha Khan", guestEmail: "aisha@example.test", startsAt: TUE_13, now: NOW },
        { meetings },
      );

      const res = await get(meeting.rescheduleToken);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8; method=REQUEST");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename=".+\.ics"$/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.text();
      expect(body).toContain("BEGIN:VCALENDAR");
      expect(body).toContain("METHOD:REQUEST");
      expect(body).toContain(`UID:${meeting.id}@launchos`);
      expect(body).toContain("DTSTART:20260908T120000Z");

      await cancelMeeting(db, organisationId, { meetingId: meeting.id, actorKind: "client", now: NOW }, { meetings });
      const cancelled = await get(meeting.rescheduleToken);
      expect(cancelled.headers.get("content-type")).toBe("text/calendar; charset=utf-8; method=CANCEL");
      expect(await cancelled.text()).toContain("METHOD:CANCEL");
    });
  });

  it("answers 404 for an unknown or malformed token without touching the database", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      expect((await get("short")).status).toBe(404);
      expect((await get("x".repeat(40))).status).toBe(404);
    });
  });
});
