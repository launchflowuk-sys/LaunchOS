import type { SocialPublishInput, SocialPublishResult, SocialPublisher } from "./types.js";

/**
 * Records every publish and answers with a deterministic id and permalink, so
 * a test can assert on what would have gone out and the publish job can be
 * exercised end to end without a Meta app or a Google project.
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
    return { externalId, url: mockUrl(input, n) };
  }
}

function mockUrl(input: SocialPublishInput, n: number): string {
  switch (input.channel) {
    case "facebook":
      return `https://www.facebook.com/${input.externalId}/posts/${n}`;
    case "instagram":
      return `https://www.instagram.com/p/mock-${n}/`;
    case "gbp":
      return `https://local.google.com/place?use=posts&lpsid=mock-${n}`;
  }
}
