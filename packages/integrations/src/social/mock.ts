import type { SocialPublishInput, SocialPublishResult, SocialPublisher } from "./types.js";

/**
 * Records every publish and answers with a deterministic id and permalink, so
 * a test can assert on what would have gone out and the publish job can be
 * exercised end to end without a Meta app.
 *
 * `failNext` queues an error for the next call, which is how the worker's
 * "mark failed, retry up to three times" path gets tested.
 */
export class MockSocialPublisher implements SocialPublisher {
  readonly name = "mock-social" as const;
  readonly calls: SocialPublishInput[] = [];
  private readonly pendingFailures: Error[] = [];

  failNext(error: Error): void {
    this.pendingFailures.push(error);
  }

  async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
    this.calls.push(input);
    const failure = this.pendingFailures.shift();
    if (failure !== undefined) throw failure;
    const n = this.calls.length;
    const externalId = `mock-${input.channel}-${n}`;
    const url =
      input.channel === "facebook"
        ? `https://www.facebook.com/${input.externalId}/posts/${n}`
        : `https://www.instagram.com/p/mock-${n}/`;
    return { externalId, url };
  }
}
