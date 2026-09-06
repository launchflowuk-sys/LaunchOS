import { renderContentImage, type RenderContentImageResult } from "@launchos/core";
import type { ImageGenAdapter } from "@launchos/integrations";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { CONTENT_WRITER_KEY } from "./content-shared.js";

/**
 * Draws the picture a drafted slot goes to approval with: a branded template
 * by default, the image generator when the client has asked for one and the
 * month's budget still has room.
 *
 * This is `safe` to the kernel's policy gate, and the argument is the same one
 * `content_request_approval` makes next door. Nothing leaves the building: the
 * bytes are written to our own storage volume and the url set on the item is
 * `/api/assets/<uuid>`, which nobody outside the office can reach until a
 * person approves the post. The `content_publish` approval is still the single
 * outward gate, and it is now a better one — the owner sees the post *and* its
 * picture on one card instead of approving words and finding out later what
 * was attached to them. Marking this `requires_approval` would park the run on
 * a `tool_call` approval, so a month of eight slots would cost eight extra
 * decisions and eight LLM round-trips before the eight that actually matter,
 * and every one of them would be a person confirming that a graphic may be
 * drawn onto a draft only they can see.
 *
 * What is bounded here is spend, not permission. The template path costs
 * nothing; the generator path is opt-in per client and stops at
 * `IMAGEGEN_MONTHLY_CAP_PENCE`, falling back to a template rather than
 * refusing, so a post never reaches approval with no picture because the
 * budget ran out. `force` is not offered to the model at all: a slot that
 * already has a picture is refused, so a run cannot spend twice on one post
 * however many times it calls this. Replacing a picture is a person's press on
 * the approval card.
 *
 * Under `AGENT_POLICY=approval_all` (or the organisation's own policy) the
 * kernel gates this call like every other, so the stricter setting still holds.
 */
export const contentRenderImage = (imagegen: ImageGenAdapter) =>
  defineTool({
    name: "content_render_image",
    description:
      "Give a drafted slot its image: a branded graphic in the client's colours, or an AI photograph when the client has " +
      "opted in and the budget allows. Call once per slot that has no photo from content_list_assets, after content_save_draft. " +
      "Returns { rendered: false, reason } when the slot already has an image or has nothing to draw a headline from.",
    input: z.object({
      itemId: z.string().uuid().describe("A slot id you saved a draft onto in this run."),
      mode: z
        .enum(["template", "ai", "auto"])
        .optional()
        .describe("Leave unset. `auto` follows the client's own setting; the other two override it and are for a person to choose."),
    }),
    risk: "safe",
    execute: async ({ itemId, mode }, ctx): Promise<RenderContentImageResult> =>
      renderContentImage(
        ctx.db,
        ctx.organisationId,
        { itemId, ...(mode !== undefined && { mode }), actorKind: "agent", actorId: CONTENT_WRITER_KEY },
        { imagegen },
      ),
  });
