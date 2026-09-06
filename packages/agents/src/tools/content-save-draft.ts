import { ContentRefused, getContentItem, listContentAssets, updateContentItem } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { CONTENT_WRITER_KEY, GBP_MAX_BODY_CHARS, codePoints } from "./content-shared.js";

const Input = z.object({
  itemId: z.string().uuid().describe("A slot id from content_list_slots."),
  title: z.string().trim().min(1).max(200).optional().describe("Required for a blog post; ignored by Facebook, Instagram and GBP."),
  body: z.string().trim().min(1).max(20_000).describe("The post text. Markdown for a blog post, plain text otherwise."),
  imagePrompt: z.string().trim().min(1).max(2000).optional().describe("What the accompanying image should show, when the client has no suitable photo; a person sources the image."),
  imageUrl: z.string().trim().url().max(2000).optional().describe("The url of one of the client's own photos from content_list_assets. Nothing else is accepted."),
  linkUrl: z.string().trim().url().max(2000).optional().describe("A page on the client's own site, when relevant."),
});

export type ContentSaveDraftResult =
  | { saved: true; itemId: string; channel: string; status: string; bodyChars: number }
  | { saved: false; itemId: string; reason: string };

/**
 * Writes the draft onto a slot. Safe: nothing leaves the building until the
 * slot is sent for approval and a person says yes.
 *
 * Three rules are enforced here rather than left to the prompt, because a
 * violation would otherwise surface weeks later at publish time: a blog post
 * needs a title (WordPress requires one), a GBP update is capped at 1500
 * code points (Google rejects longer), and an image must be one of the
 * client's own uploaded photos — a URL the model found or invented would be
 * fetched by Meta and WordPress at publish time from wherever it points. A
 * refusal is returned as data, not thrown, so the model can fix the draft
 * and try again instead of the whole run failing.
 */
export const contentSaveDraft = defineTool({
  name: "content_save_draft",
  description:
    "Save a drafted title, body, image (imageUrl from content_list_assets, or an imagePrompt when there is no photo) and link " +
    "onto a slot. Returns { saved: false, reason } when the draft breaks a rule (blog needs a title; GBP body is at most " +
    "1500 characters; imageUrl must be one of the client's own photos) so you can fix it and retry.",
  input: Input,
  risk: "safe",
  execute: async (input, ctx): Promise<ContentSaveDraftResult> => {
    const item = await getContentItem(ctx.db, ctx.organisationId, { itemId: input.itemId });
    if (!item) return { saved: false, itemId: input.itemId, reason: "No such slot in this organisation." };

    if (item.channel === "blog" && !input.title && !item.title) {
      return { saved: false, itemId: input.itemId, reason: "A blog post needs a title." };
    }
    if (item.channel === "gbp" && codePoints(input.body) > GBP_MAX_BODY_CHARS) {
      return {
        saved: false,
        itemId: input.itemId,
        reason: `A Google Business Profile update is at most ${GBP_MAX_BODY_CHARS} characters; this one is ${codePoints(input.body)}. Shorten it.`,
      };
    }

    if (input.imageUrl !== undefined) {
      const library = await listContentAssets(ctx.db, ctx.organisationId, { clientId: item.clientId, limit: 500 });
      if (!library.some((asset) => asset.url === input.imageUrl)) {
        return {
          saved: false,
          itemId: input.itemId,
          reason: "imageUrl must be the url of one of this client's photos from content_list_assets. Call it and pick one, or give an imagePrompt instead.",
        };
      }
    }

    try {
      const after = await updateContentItem(ctx.db, ctx.organisationId, {
        itemId: input.itemId,
        body: input.body,
        ...(input.title !== undefined && { title: input.title }),
        ...(input.imagePrompt !== undefined && { imagePrompt: input.imagePrompt }),
        ...(input.imageUrl !== undefined && { imageUrl: input.imageUrl }),
        ...(input.linkUrl !== undefined && { linkUrl: input.linkUrl }),
        actorKind: "agent",
        actorId: CONTENT_WRITER_KEY,
      });
      return { saved: true, itemId: after.id, channel: after.channel, status: after.status, bodyChars: codePoints(input.body) };
    } catch (error) {
      if (error instanceof ContentRefused) return { saved: false, itemId: input.itemId, reason: error.message };
      throw error;
    }
  },
});
