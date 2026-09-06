import { readFile } from "node:fs/promises";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ContentChannel, ContentStatus } from "@launchos/db/schema";
import { isImageGenRefused, type ImageGenAdapter, type ImageGenSize } from "@launchos/integrations";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { contentAssetFilePath, createContentAsset, getContentAsset, publicAssetUrl } from "../assets/content-assets.js";
import { recordAudit } from "../audit/record-audit.js";
import { clientBrandFrom, type ResolvedClientBrand } from "../clients/brand.js";
import { IMAGE_METADATA_KEY, estimatePence, imagegenSpentThisMonth, monthlyCapPence } from "./image-budget.js";
import { headlineFrom, kickerFrom } from "./image-headline.js";
import { renderTemplateImage, type ImageTemplateSize } from "./image-template.js";
import { ActorKindSchema, ContentRefused, excerpt, type ContentItemRow } from "./shared.js";

/**
 * Gives a post its picture. Two ways of drawing one: a branded template, which
 * is free and always available, or the image generator, which costs money and
 * is therefore both opt-in and capped.
 *
 * Nothing here leaves the building — the `content_publish` approval is still
 * the single outward gate — so the bound on this is spend, not permission.
 */

/** The channels a picture is worth drawing for. Every channel today; the guard is for the next one. */
export const IMAGE_CHANNELS: readonly ContentChannel[] = ["facebook", "instagram", "gbp", "blog"];

export function channelTakesImage(channel: ContentChannel): boolean {
  return IMAGE_CHANNELS.includes(channel);
}

/**
 * Statuses a picture may still be attached to. `publishing` is in flight and
 * `published` is out of our hands; a `cancelled` item is not going anywhere.
 * Everything else — including `approved` and `scheduled` — is fair game,
 * because the last-chance backfill before publishing exists precisely to catch
 * an approved social post that reached its slot without an image.
 */
export const IMAGE_RENDERABLE_STATUSES: readonly ContentStatus[] = [
  "draft", "awaiting_approval", "approved", "scheduled", "rejected", "failed",
];

/** Comfortably inside `createContentAsset`'s 500-character `alt`, ellipsis included. */
const ALT_MAX_CHARS = 480;

/** `content_briefs.metadata.images` — where a client opts in to AI photography. */
export const BRIEF_IMAGES_METADATA_KEY = "images";

/** Square for a feed, landscape for a blog card. Both mirror `IMAGE_TEMPLATE_SIZES`. */
function templateSizeFor(channel: ContentChannel): ImageTemplateSize {
  return channel === "blog" ? "landscape" : "square";
}

function generatorSizeFor(channel: ContentChannel): ImageGenSize {
  return channel === "blog" ? "1536x1024" : "1024x1024";
}

export const RenderContentImageInput = z.object({
  itemId: z.string().uuid(),
  /** `auto` is what the agent and the backfill send; the editor's dropdown sends the other two. */
  mode: z.enum(["template", "ai", "auto"]).default("auto"),
  /** Replaces a picture the item already has. The regenerate button, and nothing else. */
  force: z.boolean().default(false),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().min(1).optional(),
});
export type RenderContentImageInput = z.input<typeof RenderContentImageInput>;

/** Injected so a test — and the whole worker — can run on the mock generator. */
export interface RenderContentImageDeps {
  imagegen: ImageGenAdapter;
}

/**
 * Why a request for AI came back with a template. Never a refusal: a plain
 * picture beats no picture, so these are recorded and reported, not thrown.
 */
export type ImageFallbackReason = "monthly_cap" | "no_prompt" | "generator_refused";

export interface RenderedContentImage {
  rendered: true;
  itemId: string;
  assetId: string;
  url: string;
  mode: "template" | "ai";
  costPence: number;
  /** Set only when AI was asked for and a template was drawn instead. */
  reason?: ImageFallbackReason;
  /** A sentence for a toast or an agent, when there is something to say. */
  message?: string;
}

export interface RefusedContentImage {
  rendered: false;
  itemId: string;
  reason: ContentRefused["reason"];
  message: string;
}

export type RenderContentImageResult = RenderedContentImage | RefusedContentImage;

/** The stored `metadata.image`, rebuilt whole on every render — never patched in place. */
interface ImageMetadata extends Record<string, unknown> {
  mode: "template" | "ai";
  model: string;
  costPence: number;
  assetId: string;
  generatedAt: string;
  prompt?: string;
  fellBackFrom?: ImageFallbackReason;
}

const BriefImageSettings = z.object({ mode: z.enum(["template", "ai"]).optional() });

/** True only when the client's brief has actually opted in; anything unreadable reads as no. */
function briefWantsAi(metadata: Record<string, unknown> | null | undefined): boolean {
  const raw = metadata?.[BRIEF_IMAGES_METADATA_KEY];
  if (!raw || typeof raw !== "object") return false;
  const parsed = BriefImageSettings.safeParse(raw);
  return parsed.success && parsed.data.mode === "ai";
}

type ItemWithClient = {
  item: ContentItemRow;
  brand: ResolvedClientBrand;
  area: string | null;
  wantsAi: boolean;
};

/** The item, its client's brand and its brief, in one read and one organisation. */
async function loadForRender(db: Db, organisationId: string, itemId: string): Promise<ItemWithClient> {
  const [found] = await db
    .select({
      item: schema.contentItems,
      name: schema.clients.name,
      tradingName: schema.clients.tradingName,
      clientMetadata: schema.clients.metadata,
    })
    .from(schema.contentItems)
    .innerJoin(schema.clients, eq(schema.contentItems.clientId, schema.clients.id))
    .where(and(
      eq(schema.contentItems.id, itemId),
      eq(schema.contentItems.organisationId, organisationId),
      isNull(schema.contentItems.deletedAt),
    ));
  if (!found) throw new ContentRefused("not_found", `content item ${itemId} not found in organisation`);

  const [brief] = await db
    .select({ area: schema.contentBriefs.area, metadata: schema.contentBriefs.metadata })
    .from(schema.contentBriefs)
    .where(and(
      eq(schema.contentBriefs.organisationId, organisationId),
      eq(schema.contentBriefs.clientId, found.item.clientId),
      isNull(schema.contentBriefs.deletedAt),
    ));

  return {
    item: found.item,
    brand: clientBrandFrom({ name: found.name, tradingName: found.tradingName, metadata: found.clientMetadata }),
    area: brief?.area ?? null,
    wantsAi: briefWantsAi(brief?.metadata),
  };
}

/**
 * Bytes on an `ArrayBuffer` this process owns. Node's `Buffer` and the image
 * adapters both type theirs as `ArrayBufferLike`, which admits shared memory;
 * Satori and the asset store both want the narrower thing, and a logo or a
 * post image is small enough that a copy is not worth a cast.
 */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

/** The client's logo, when they have one and its file is still there. A missing logo is not an error. */
async function loadLogo(
  db: Db,
  organisationId: string,
  clientId: string,
  brand: ResolvedClientBrand,
  env: NodeJS.ProcessEnv,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string } | undefined> {
  if (!brand.logoAssetId) return undefined;
  const asset = await getContentAsset(db, organisationId, { assetId: brand.logoAssetId });
  // Belt and braces over `setClientBrand`'s check: a logo is drawn onto this
  // client's post, so it has to be this client's image today, not when it was set.
  if (!asset || asset.clientId !== clientId) return undefined;
  try {
    return { bytes: owned(await readFile(contentAssetFilePath(asset, env))), mime: asset.mime };
  } catch {
    return undefined;
  }
}

/** Sets `image_url` and rewrites `metadata.image` in one audited write. */
async function attachImage(
  db: Db,
  organisationId: string,
  before: ContentItemRow,
  image: ImageMetadata,
  url: string,
  actor: { actorKind: z.infer<typeof ActorKindSchema>; actorId?: string | undefined },
): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.contentItems)
      .set({
        imageUrl: url,
        updatedAt: new Date(),
        // The whole `image` key is replaced and every other metadata key is
        // left alone, so nothing read above is mutated and a concurrent write
        // to `slot` or `cancelledAt` survives.
        metadata: sql`coalesce(${schema.contentItems.metadata}, '{}'::jsonb) || ${JSON.stringify({ [IMAGE_METADATA_KEY]: image })}::jsonb`,
      })
      .where(and(eq(schema.contentItems.id, before.id), eq(schema.contentItems.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: actor.actorKind, actorId: actor.actorId, action: "content_item.image_rendered",
      targetType: "content_item", targetId: before.id, before, after,
    });
  });
}

/**
 * Draws a picture for a post and attaches it.
 *
 * `mode: "auto"` picks AI only when the content writer left an `image_prompt`
 * **and** the client's brief opted in; everything else gets the branded
 * template. AI is checked against `IMAGEGEN_MONTHLY_CAP_PENCE` **before** the
 * call, not after — a cap enforced after the spend is not a cap — and a
 * request that would take the month past it is drawn as a template instead,
 * with the reason in the result. The same is true of a generator that says no:
 * a post with a plain picture is a better outcome than a post with none.
 *
 * Refusals come back as `{ rendered: false, reason, message }` rather than
 * thrown, so a web action can toast the sentence and an agent can read the
 * reason and move on.
 */
export async function renderContentImage(
  db: Db,
  organisationId: string,
  input: RenderContentImageInput,
  deps: RenderContentImageDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RenderContentImageResult> {
  const v = RenderContentImageInput.parse(input);
  try {
    const { item, brand, area, wantsAi } = await loadForRender(db, organisationId, v.itemId);

    if (!channelTakesImage(item.channel)) {
      throw new ContentRefused("no_image_channel", `A ${item.channel} post does not carry an image.`);
    }
    if (!IMAGE_RENDERABLE_STATUSES.includes(item.status)) {
      throw new ContentRefused("not_editable", `A ${item.status.replace("_", " ")} post's image cannot be changed.`);
    }
    if (item.imageUrl && !v.force) {
      throw new ContentRefused("already_has_image", "This post already has an image. Use Regenerate to replace it.");
    }
    const headline = headlineFrom(item.title?.trim() || item.body || "");
    if (!headline) throw new ContentRefused("empty_body", "Write the post before drawing its image.");

    const prompt = item.imagePrompt?.trim() || null;
    const wantsGenerator = v.mode === "ai" || (v.mode === "auto" && prompt !== null && wantsAi);

    // Loaded whichever path runs: template mode is the default, and it is the
    // one that actually draws the logo.
    const subject = { item, brand, area, headline, logo: await loadLogo(db, organisationId, item.clientId, brand, env) };
    const drawn = wantsGenerator
      ? await generateOrFallBack(db, organisationId, { ...subject, prompt }, deps, env)
      : { ...(await drawTemplate(subject)), mode: "template" as const, costPence: 0, model: "template" };

    const asset = await createContentAsset(db, organisationId, {
      clientId: item.clientId,
      bytes: drawn.bytes,
      mime: drawn.mime,
      // `content_assets.alt` stops at 500 characters and an `image_prompt` may
      // run to 2000, so the prompt is cut to fit rather than being allowed to
      // fail the whole render on a validation error.
      alt: drawn.mode === "ai" && prompt ? excerpt(prompt, ALT_MAX_CHARS) : headline,
      source: "generated",
      actorKind: v.actorKind,
      ...(v.actorId ? { actorId: v.actorId } : {}),
    }, env);

    const url = publicAssetUrl(asset.id, env);
    const image: ImageMetadata = {
      mode: drawn.mode,
      model: drawn.model,
      costPence: drawn.costPence,
      assetId: asset.id,
      generatedAt: new Date().toISOString(),
      ...(drawn.mode === "ai" && prompt ? { prompt } : {}),
      ...(drawn.reason ? { fellBackFrom: drawn.reason } : {}),
    };
    await attachImage(db, organisationId, item, image, url, { actorKind: v.actorKind, actorId: v.actorId });

    return {
      rendered: true, itemId: item.id, assetId: asset.id, url, mode: drawn.mode, costPence: drawn.costPence,
      ...(drawn.reason ? { reason: drawn.reason, message: drawn.message } : {}),
    };
  } catch (error) {
    if (error instanceof ContentRefused) {
      return { rendered: false, itemId: v.itemId, reason: error.reason, message: error.message };
    }
    throw error;
  }
}

type Drawn = {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  mode: "template" | "ai";
  model: string;
  costPence: number;
  reason?: ImageFallbackReason;
  message?: string;
};

type Subject = {
  item: ContentItemRow;
  brand: ResolvedClientBrand;
  area: string | null;
  headline: string;
  logo: { bytes: Uint8Array<ArrayBuffer>; mime: string } | undefined;
};

async function drawTemplate(subject: Subject): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  const kicker = kickerFrom(subject.area);
  return renderTemplateImage({
    headline: subject.headline,
    ...(kicker ? { kicker } : {}),
    wordmark: subject.brand.wordmark,
    ...(subject.logo ? { logo: subject.logo } : {}),
    brand: { primary: subject.brand.primary, accent: subject.brand.accent },
    size: templateSizeFor(subject.item.channel),
  });
}

/**
 * The AI path, with the two ways it declines to spend: no prompt to send, and
 * a month that has already had its money. Both draw the template instead and
 * say which happened; only the caller's `mode` is ever disappointed, never the
 * post.
 */
async function generateOrFallBack(
  db: Db,
  organisationId: string,
  subject: Subject & { prompt: string | null },
  deps: RenderContentImageDeps,
  env: NodeJS.ProcessEnv,
): Promise<Drawn> {
  const template = async (reason: ImageFallbackReason, message: string): Promise<Drawn> => ({
    ...(await drawTemplate(subject)), mode: "template", model: "template", costPence: 0, reason, message,
  });

  if (!subject.prompt) {
    return template("no_prompt", "This post has no image prompt, so a branded graphic was drawn instead.");
  }

  const size = generatorSizeFor(subject.item.channel);
  const estimate = estimatePence(deps.imagegen.name, size);
  const cap = monthlyCapPence(env);
  const spent = await imagegenSpentThisMonth(db, organisationId);
  if (spent + estimate > cap) {
    // Checked before the call and never after: this is the whole point of the
    // cap. The template is drawn from the same brand, so the post still ships.
    return template(
      "monthly_cap",
      `This month's image budget (${(cap / 100).toFixed(2)} pounds) is spent, so a branded graphic was drawn instead.`,
    );
  }

  try {
    const generated = await deps.imagegen.generate({ prompt: subject.prompt, size });
    return { bytes: owned(generated.bytes), mime: generated.mime, mode: "ai", model: generated.model, costPence: generated.costPence };
  } catch (error) {
    if (!isImageGenRefused(error)) throw error;
    return template("generator_refused", `The image generator refused (${error.code}), so a branded graphic was drawn instead.`);
  }
}
