import { PeriodKeySchema, SERVICE_FOR_CHANNEL, activeServicesForClient, listContentItems } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * The month's plan for one client: every slot with its channel, status and
 * publish moment, and whether it still needs writing. "Unfilled" is a draft
 * with no body — the empty slots `planContentMonth` laid out, and any post a
 * person or client started but left blank.
 *
 * A slot for a service that has since been switched off is `held` and never
 * unfilled: it was planned while the service was on, it is kept so switching
 * back on carries on, and writing it now would spend a model turn on a post
 * nobody will publish.
 */
export const contentListSlots = defineTool({
  name: "content_list_slots",
  description:
    "List the client's content slots for a month (periodKey YYYY-MM): id, channel, kind, status, scheduled date, " +
    "title and whether the slot is still unfilled. Draft only the slots where unfilled is true. " +
    "A held slot belongs to a service that is switched off for this client: leave it alone.",
  input: z.object({ clientId: z.string().uuid(), periodKey: PeriodKeySchema }),
  risk: "safe",
  execute: async ({ clientId, periodKey }, ctx) => {
    const [{ items }, active] = await Promise.all([
      listContentItems(ctx.db, ctx.organisationId, { clientId, periodKey, limit: 200 }),
      activeServicesForClient(ctx.db, ctx.organisationId, clientId),
    ]);
    const slots = items.map((item) => ({
      id: item.id,
      channel: item.channel,
      kind: item.kind,
      status: item.status,
      scheduledFor: item.scheduledFor?.toISOString() ?? null,
      title: item.title,
      hasBody: Boolean(item.body?.trim()),
      source: item.source,
      held: !active.has(SERVICE_FOR_CHANNEL[item.channel]),
      unfilled: active.has(SERVICE_FOR_CHANNEL[item.channel]) && item.status === "draft" && !item.body?.trim(),
    }));
    return { periodKey, slots, unfilled: slots.filter((s) => s.unfilled).length };
  },
});
