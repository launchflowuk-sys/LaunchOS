import { listContentAssets } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export interface ContentAssetSummary {
  id: string;
  /** The public URL a post carries as its image; pass it to content_save_draft as imageUrl. */
  url: string;
  alt: string | null;
  originalName: string | null;
  mime: string;
  /** Who added it: the client through the portal, staff, or a generator. */
  source: string;
  uploadedAt: string;
}

/** Newest first; a month's worth of choice is plenty for one run. */
const LIST_LIMIT = 50;

/**
 * The client's photo library: every image uploaded for their posts, with the
 * URL a slot's `imageUrl` must carry. Safe — it reads our own rows. The
 * writer calls it once per run and picks an image per social slot; a client
 * with no photos gets an empty list, and the prompt says what to do then
 * (an image prompt for a person to source).
 */
export const contentListAssets = defineTool({
  name: "content_list_assets",
  description:
    "List the client's uploaded photos (id, url, alt text, file name, when added), newest first. " +
    "Pick one per Facebook or Instagram slot and pass its url to content_save_draft as imageUrl; " +
    "an empty list means the client has no photos yet.",
  input: z.object({ clientId: z.string().uuid() }),
  risk: "safe",
  execute: async ({ clientId }, ctx): Promise<{ assets: ContentAssetSummary[]; count: number }> => {
    const rows = await listContentAssets(ctx.db, ctx.organisationId, { clientId, limit: LIST_LIMIT });
    const assets = rows.map((asset) => ({
      id: asset.id,
      url: asset.url,
      alt: asset.alt,
      originalName: asset.originalName,
      mime: asset.mime,
      source: asset.source,
      uploadedAt: asset.createdAt.toISOString(),
    }));
    return { assets, count: assets.length };
  },
});
