import { cmsProviderFor, type CmsProviderFactory } from "@launchos/agents";
import {
  claimDueContent, excerpt, listContentChannels, markContentFailed, markContentPublished, type ContentItemRow,
} from "@launchos/core";
import type { Db } from "@launchos/db";
import type { ContentChannel } from "@launchos/db/schema";
import { SocialApiError, WordPressCmsError, type CmsProvider, type SocialPublisher } from "@launchos/integrations";
import { sweep, throwOnSweepFailure, type SweepLogger } from "./sweep.js";

export interface PublishDueLogger extends SweepLogger {
  info(...args: unknown[]): void;
}

export interface PublishDueDeps {
  readonly db: Db;
  /** Facebook, Instagram and GBP — the composite `createSocialPublisherFromEnv` builds. */
  readonly social: SocialPublisher;
  /** The blog: a provider, or the per-organisation factory production wires (`scopedCmsProvider`). */
  readonly cms: CmsProvider | CmsProviderFactory;
  readonly logger?: PublishDueLogger;
}

export interface PublishDueOptions {
  now: Date;
  /** How many due items one sweep takes; the rest wait five minutes. */
  limit?: number;
}

export interface PublishDueResult {
  claimed: number;
  published: number;
  /** Failed this time but put back for the next sweep. */
  retried: number;
  /** Given up on: retries exhausted, or an error a retry cannot fix. */
  failed: number;
  /** Bookkeeping itself threw — the item is left `publishing` for a person. */
  errored: number;
}

/** What `markContentFailed` is told: the message for the human, and whether trying again could help. */
export interface PublishFailure {
  message: string;
  retry: boolean;
}

/** What a client has to connect before a channel can publish — the noun in the "not connected" message. */
const CONNECTION_FOR_CHANNEL: Record<ContentChannel, string> = {
  facebook: "Facebook Page",
  instagram: "Instagram account",
  blog: "blog site",
  gbp: "Google Business Profile location",
};

/** A WordPress failure a retry cannot fix: the site is not set up, or the credentials are wrong. */
const WORDPRESS_PERMANENT = new Set(["no_credentials", "not_wordpress", "invalid_site_url", "auth_failed"]);

/**
 * Sorts a publisher's error into "try again later" and "a person has to
 * look". Auth and media errors from Meta or Google, and a WordPress site with
 * no credentials, will fail identically next time; rate limits, timeouts and
 * a failed request may not. Anything that is not a typed adapter error — a
 * pre-flight `TypeError` for a malformed location name, a bug — is treated
 * as permanent: three identical crashes would tell nobody anything new.
 */
export function classifyPublishError(error: unknown): PublishFailure {
  if (error instanceof SocialApiError) {
    const retry = error.code === "rate_limit" || error.code === "timeout" || error.code === "request_failed";
    return { message: error.message, retry };
  }
  if (error instanceof WordPressCmsError) {
    return { message: error.message, retry: !WORDPRESS_PERMANENT.has(error.code) };
  }
  return { message: error instanceof Error ? error.message : String(error), retry: false };
}

/** A failure decided before any adapter is called. Carries its own retry verdict. */
class PublishRefused extends Error {
  constructor(message: string, readonly retry: boolean) {
    super(message);
    this.name = "PublishRefused";
  }
}

async function publishOne(
  deps: PublishDueDeps,
  organisationId: string,
  item: ContentItemRow,
): Promise<{ externalId: string; externalUrl?: string }> {
  const body = item.body?.trim();
  if (!body) throw new PublishRefused("The post has no text.", false);

  const channels = await listContentChannels(deps.db, organisationId, { clientId: item.clientId, enabledOnly: true });
  const channel = channels.find((c) => c.channel === item.channel);
  if (!channel) {
    throw new PublishRefused(
      `No ${CONNECTION_FOR_CHANNEL[item.channel]} is connected for this client. ` +
      "Connect it under the client's Content tab and send the post again.",
      false,
    );
  }

  if (item.channel === "blog") {
    const provider = cmsProviderFor(deps.cms, { db: deps.db, organisationId });
    const result = await provider.createPost({
      siteId: channel.externalId,
      title: item.title?.trim() || excerpt(body, 80),
      contentMarkdown: body,
      status: "publish",
      ...(item.imageUrl ? { featuredImageUrl: item.imageUrl } : {}),
    });
    if (result.note) deps.logger?.info({ itemId: item.id, note: result.note }, "blog post published with a note");
    return { externalId: result.externalId, externalUrl: result.url };
  }

  // Instagram has no text-only post. The real publisher refuses too, but the
  // mock does not, so the rule is stated here where a local run will hit it.
  if (item.channel === "instagram" && !item.imageUrl) {
    throw new PublishRefused("Instagram needs an image. Add one to the post and send it again.", false);
  }

  const result = await deps.social.publish({
    channel: item.channel,
    externalId: channel.externalId,
    text: body,
    ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
    ...(item.linkUrl ? { linkUrl: item.linkUrl } : {}),
  });
  return { externalId: result.externalId, ...(result.url ? { externalUrl: result.url } : {}) };
}

/**
 * Every five minutes: claims the approved items whose time has come and
 * publishes each one on its channel.
 *
 * The claim is the status flip to `publishing`, so a worker that dies
 * mid-post leaves the item visibly stuck rather than posted twice by the next
 * sweep. Every outcome lands on the item through core's bookkeeping: the id
 * and permalink on success, or an attempt counted and the item put back for
 * the next sweep — or failed outright, and the owner told, when the error is
 * one a retry cannot fix. Each item has its own error boundary; only a throw
 * from the bookkeeping itself reaches the job's failure.
 */
export async function runPublishDue(deps: PublishDueDeps, organisationId: string, options: PublishDueOptions): Promise<PublishDueResult> {
  const logger = deps.logger ?? console;
  const items = await claimDueContent(deps.db, organisationId, { now: options.now, ...(options.limit !== undefined && { limit: options.limit }) });

  let published = 0;
  let retried = 0;
  let failed = 0;
  const label = `content publish-due (${organisationId})`;
  const summary = await sweep(items, { label, id: (item) => item.id, logger }, async (item) => {
    let failure: PublishFailure | undefined;
    let outcome: { externalId: string; externalUrl?: string } | undefined;
    try {
      outcome = await publishOne(deps, organisationId, item);
    } catch (error) {
      failure = error instanceof PublishRefused ? { message: error.message, retry: error.retry } : classifyPublishError(error);
    }

    if (outcome) {
      await markContentPublished(deps.db, organisationId, { itemId: item.id, ...outcome });
      published += 1;
      return;
    }
    const marked = await markContentFailed(deps.db, organisationId, { itemId: item.id, error: failure!.message, retry: failure!.retry });
    if (marked.exhausted) failed += 1;
    else retried += 1;
    logger.error(
      { itemId: item.id, channel: item.channel, attempts: marked.attempts, exhausted: marked.exhausted, error: failure!.message },
      "content publish failed",
    );
  });

  const result: PublishDueResult = { claimed: items.length, published, retried, failed, errored: summary.failed };
  if (items.length > 0) logger.info({ organisationId, ...result }, "content publish-due");
  throwOnSweepFailure(label, summary);
  return result;
}
