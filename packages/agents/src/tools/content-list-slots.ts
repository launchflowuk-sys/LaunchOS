import { PeriodKeySchema, listContentItems } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * The month's plan for one client: every slot with its channel, status and
 * publish moment, and whether it still needs writing. "Unfilled" is a draft
 * with no body — the empty slots `planContentMonth` laid out, and any post a
 * person or client started but left blank.
 */
export const contentListSlots = defineTool({
  name: "content_list_slots",
  description:
    "List the client's content slots for a month (periodKey YYYY-MM): id, channel, kind, status, scheduled date, " +
    "title and whether the slot is still unfilled. Draft only the slots where unfilled is true.",
  input: z.object({ clientId: z.string().uuid(), periodKey: PeriodKeySchema }),
  risk: "safe",
  execute: async ({ clientId, periodKey }, ctx) => {
    const { items } = await listContentItems(ctx.db, ctx.organisationId, { clientId, periodKey, limit: 200 });
    const slots = items.map((item) => ({
      id: item.id,
      channel: item.channel,
      kind: item.kind,
      status: item.status,
      scheduledFor: item.scheduledFor?.toISOString() ?? null,
      title: item.title,
      hasBody: Boolean(item.body?.trim()),
      source: item.source,
      unfilled: item.status === "draft" && !item.body?.trim(),
    }));
    return { periodKey, slots, unfilled: slots.filter((s) => s.unfilled).length };
  },
});
