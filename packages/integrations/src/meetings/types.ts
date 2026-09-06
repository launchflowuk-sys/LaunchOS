export interface CreateMeetingInput {
  topic: string;
  /** UTC instant. */
  startsAt: Date;
  durationMinutes: number;
  /** IANA zone the meeting is scheduled in (the host's), e.g. `Europe/London`. */
  timezone: string;
  /** The host's email — informational for the provider; Zoom S2S always creates under `users/me`. */
  hostEmail: string;
  agenda?: string | undefined;
}

export interface ProviderMeeting {
  providerMeetingId: string;
  /** What the guest opens. */
  joinUrl: string;
  /** What the host opens — carries a start token on Zoom; never emailed to a guest. */
  hostUrl: string;
}

export interface UpdateMeetingInput {
  startsAt: Date;
  durationMinutes: number;
}

/**
 * The video-call provider behind a booking. Three calls, none of which read
 * the database: `bookMeeting` creates the provider meeting *before* its
 * transaction, `rescheduleMeeting` updates it, `cancelMeeting` deletes it. A
 * delete of a meeting the provider no longer knows is not an error.
 */
export interface MeetingsAdapter {
  readonly name: "mock" | "zoom";
  createMeeting(input: CreateMeetingInput): Promise<ProviderMeeting>;
  updateMeeting(providerMeetingId: string, input: UpdateMeetingInput): Promise<void>;
  deleteMeeting(providerMeetingId: string): Promise<void>;
}

export type MeetingsErrorKind = "auth" | "not_found" | "rate_limit" | "request_failed" | "timeout";

/** A provider failure, classified so a caller can tell "try again" from "fix the keys". */
export class MeetingsApiError extends Error {
  constructor(readonly kind: MeetingsErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = "MeetingsApiError";
  }
}
