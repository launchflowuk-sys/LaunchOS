import { randomUUID } from "node:crypto";
import type { CreateMeetingInput, MeetingsAdapter, ProviderMeeting, UpdateMeetingInput } from "./types.js";

/**
 * In-memory Zoom stand-in. Ids are prefixed `mock_` so one can never be
 * mistaken for a real Zoom id; the URLs are on `meet.launchflow.example`,
 * which resolves nowhere on purpose. Records every call so a test can read
 * what would have reached the provider. A delete of an unknown id is a no-op,
 * matching how the real adapter treats a 404.
 */
export class MockMeetingsAdapter implements MeetingsAdapter {
  readonly name = "mock" as const;
  readonly created: (CreateMeetingInput & ProviderMeeting)[] = [];
  readonly updated: { providerMeetingId: string; input: UpdateMeetingInput }[] = [];
  readonly deleted: string[] = [];
  /** Set to make the next `createMeeting` throw, for the failure-path tests. */
  failNextCreate: Error | null = null;

  async createMeeting(input: CreateMeetingInput): Promise<ProviderMeeting> {
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    const id = `mock_${randomUUID().replace(/-/g, "").slice(0, 11)}`;
    const meeting: ProviderMeeting = {
      providerMeetingId: id,
      joinUrl: `https://meet.launchflow.example/j/${id}`,
      hostUrl: `https://meet.launchflow.example/s/${id}?host=1`,
    };
    this.created.push({ ...input, ...meeting });
    return meeting;
  }

  async updateMeeting(providerMeetingId: string, input: UpdateMeetingInput): Promise<void> {
    this.updated.push({ providerMeetingId, input });
  }

  async deleteMeeting(providerMeetingId: string): Promise<void> {
    this.deleted.push(providerMeetingId);
  }
}
