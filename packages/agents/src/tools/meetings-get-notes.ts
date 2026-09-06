import { listMeetings } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/** How many past calls are worth reading before writing a quote. */
const MAX_MEETINGS = 5;

/**
 * The calls we have already had with this person, and what was said on them.
 *
 * A proposal written from the enquiry form alone quotes the wrong thing. The
 * discovery call is where the real brief is — how many pages, whether there
 * is an existing site, what "more customers" actually means to them — and
 * Shoji types it into `meetings.notes` while he is on the phone. This is the
 * one tool that hands the model that paragraph.
 *
 * Past calls first and newest first, because a proposal follows a call rather
 * than preceding one; an upcoming call is listed too, with no notes on it, so
 * the model can see that the discovery is booked but has not happened and say
 * so rather than inventing the brief.
 *
 * Everything returned is our own row. Nothing here is the model's, and a
 * meeting from another organisation cannot appear: `listMeetings` filters on
 * `organisationId` first.
 */
export const meetingsGetNotes = defineTool({
  name: "meetings_get_notes",
  description:
    "Read the notes from the calls we have had with this lead or client — the discovery call's brief in Shoji's own words, " +
    "plus whether the call happened, was a no-show or is still to come. Pass leadId or clientId. " +
    "Returns { meetings: [] } when there has been no call; write from the enquiry alone in that case and say so.",
  input: z.object({
    leadId: z.string().uuid().optional().describe("The lead the proposal is for."),
    clientId: z.string().uuid().optional().describe("The client the proposal is for, when they are already on the books."),
  }),
  risk: "safe",
  execute: async ({ leadId, clientId }, ctx) => {
    if (!leadId && !clientId) return { meetings: [], reason: "Pass leadId or clientId." };
    const scoped = { ...(leadId ? { leadId } : {}), ...(clientId ? { clientId } : {}) };
    const [past, upcoming] = await Promise.all([
      listMeetings(ctx.db, ctx.organisationId, { ...scoped, scope: "past", limit: MAX_MEETINGS, now: ctx.now() }),
      listMeetings(ctx.db, ctx.organisationId, { ...scoped, scope: "upcoming", limit: MAX_MEETINGS, now: ctx.now() }),
    ]);
    return {
      meetings: [...past, ...upcoming].map((meeting) => ({
        id: meeting.id,
        kind: meeting.kind,
        status: meeting.status,
        startsAt: meeting.startsAt.toISOString(),
        guestName: meeting.guestName,
        held: meeting.status === "completed",
        notes: meeting.notes,
      })),
    };
  },
});
