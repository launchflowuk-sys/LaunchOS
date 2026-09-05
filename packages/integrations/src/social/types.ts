/**
 * Publishing an approved post to a client's social channel.
 *
 * One interface, three channels. The channel is a field rather than a method
 * because the worker that calls this holds a `content_items` row whose
 * `channel` column already says which one — a `switch` at the call site would
 * be the same information twice.
 */

export type SocialChannel = "facebook" | "instagram" | "gbp";

export interface SocialPublishInput {
  readonly channel: SocialChannel;
  /**
   * `content_channels.external_id`: the Facebook Page id, the Instagram
   * Business user id, or — for `gbp` — the Business Profile *location resource
   * name*, `accounts/{accountId}/locations/{locationId}`, exactly as
   * `GbpPublisher.listLocations()` returns it.
   */
  readonly externalId: string;
  /** The post body. Facebook: `message` / photo `caption`. Instagram: `caption`. GBP: `summary`, at most 1500 characters. */
  readonly text: string;
  /**
   * A publicly fetchable image. Optional on Facebook (a text or link post
   * without one) and on GBP, required on Instagram, which has no text-only post.
   */
  readonly imageUrl?: string | undefined;
  /**
   * Facebook attaches this as the post's link preview on a text post. A photo
   * post cannot carry a link attachment, and Instagram captions are plain text,
   * so on those two it is appended to the caption instead. GBP turns it into a
   * "Learn more" call-to-action button.
   */
  readonly linkUrl?: string | undefined;
}

export interface SocialPublishResult {
  /**
   * The provider's id for the published post: `<pageId>_<postId>` on Facebook,
   * the media id on Instagram, the local post resource name
   * (`accounts/…/locations/…/localPosts/…`) on GBP.
   */
  readonly externalId: string;
  /**
   * The public permalink, when the follow-up lookup succeeded. Absent — never a
   * throw — when it did not: the post is live by then, and a failure here must
   * not make the caller retry and publish it twice.
   */
  readonly url?: string | undefined;
}

/**
 * `mock-social` when nothing real is configured; otherwise the real halves
 * joined with `+`, which is the vocabulary `adapter-guard.ts` reports in.
 */
export type SocialPublisherName = "mock-social" | "meta" | "gbp" | "meta+gbp";

export interface SocialPublisher {
  readonly name: SocialPublisherName;
  publish(input: SocialPublishInput): Promise<SocialPublishResult>;
}
