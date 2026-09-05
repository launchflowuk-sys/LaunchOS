import { ContentRefused, getContentItem, updateContentItem } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { CONTENT_WRITER_KEY, GBP_MAX_BODY_CHARS, codePoints } from "./content-shared.js";

const Input = z.object({
  itemId: z.string().uuid().describe("A slot id from content_list_slots."),
  title: z.string().trim().min(1).max(200).optional().describe("Required for a blog post; ignored by Facebook, Instagram and GBP."),
  body: z.string().trim().min(1).max(20_000).describe("The post text. Markdown for a blog post, plain text otherwise."),
  imagePrompt: z.string().trim().min(1).max(2000).optional().describe("What the accompanying image should show; a person sources the image."),
  linkUrl: z.string().trim().url().max(2000).optional().describe("A page on the client's own site, when relevant."),
});

export type ContentSaveDraftResult =
  | { saved: true; itemId: string; channel: string; status: string; bodyChars: number }
  | { saved: false; itemId: string; reason: string };

/**
 * Writes the draft onto a slot. Safe: nothing leaves the building until the
 * slot is sent for approval and a person says yes.
 *
 * Two rules are enforced here rather than left to the prompt, because a
 * violation would otherwise surface weeks later at publish time: a blog post
 * needs a title (WordPress requires one), and a GBP update is capped at 1500
 * code points (Google rejects longer). A refusal is returned as data, not
 * thrown, so the model can shorten the text and try again instead of the
 * whole run failing.
 */
export const contentSaveDraft = defineTool({
  name: "content_save_draft",
  description:
    "Save a drafted title, body, image prompt and link onto a slot. Returns { saved: false, reason } when the " +
    "draft breaks a channel rule (blog needs a title; GBP body is at most 1500 characters) so you can fix it and retry.",
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

    try {
      const after = await updateContentItem(ctx.db, ctx.organisationId, {
        itemId: input.itemId,
        body: input.body,
        ...(input.title !== undefined && { title: input.title }),
        ...(input.imagePrompt !== undefined && { imagePrompt: input.imagePrompt }),
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
