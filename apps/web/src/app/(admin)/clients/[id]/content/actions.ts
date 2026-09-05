"use server";

import { ContentRefused, setContentChannel, upsertContentBrief } from "@launchos/core";
import { schema } from "@launchos/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

const BriefText = z.string().trim().max(4000).optional();

const BriefSchema = z.object({
  clientId: z.string().uuid(),
  tone: BriefText,
  audience: BriefText,
  services: BriefText,
  offers: BriefText,
  area: BriefText,
  doNotSay: BriefText,
  notes: BriefText,
});

const ChannelSchema = z.object({
  clientId: z.string().uuid(),
  channel: z.enum(schema.contentChannelEnum.enumValues),
  externalId: z.string().trim().min(1, "Enter the id first").max(200),
  displayName: z.string().trim().max(200).optional(),
  enabled: z.enum(["true", "false"]).transform((v) => v === "true"),
});

function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : undefined;
}

/** A blank textarea is "no entry", which core stores as null. */
function text(formData: FormData, name: string): string | undefined {
  const raw = value(formData, name)?.trim();
  return raw ? raw : undefined;
}

function failed(error: unknown, fallback: string): ActionResult {
  if (error instanceof ContentRefused) return { status: "error", message: error.message };
  console.error(fallback, error);
  return { status: "error", message: error instanceof Error ? error.message : fallback };
}

/** Replaces the whole brief: what the content writer is told about this client. */
export async function saveContentBriefAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = BriefSchema.safeParse({
    clientId: value(formData, "clientId"),
    tone: text(formData, "tone"),
    audience: text(formData, "audience"),
    services: text(formData, "services"),
    offers: text(formData, "offers"),
    area: text(formData, "area"),
    doNotSay: text(formData, "doNotSay"),
    notes: text(formData, "notes"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the brief and try again" };

  try {
    const brief = await upsertContentBrief(getDb(), session.organisationId, {
      ...parsed.data,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}/content`);
    return { status: "ok", id: brief.id };
  } catch (error) {
    return failed(error, "Could not save the brief");
  }
}

/** Connects (or updates) one channel: the Page, the IG account, the blog site or the GBP location. */
export async function saveContentChannelAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const displayName = text(formData, "displayName");
  const parsed = ChannelSchema.safeParse({
    clientId: value(formData, "clientId"),
    channel: value(formData, "channel"),
    externalId: value(formData, "externalId") ?? "",
    ...(displayName ? { displayName } : {}),
    enabled: value(formData, "enabled") ?? "true",
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the channel and try again" };
  const v = parsed.data;

  try {
    const row = await setContentChannel(getDb(), session.organisationId, {
      clientId: v.clientId,
      channel: v.channel,
      externalId: v.externalId,
      ...(v.displayName ? { displayName: v.displayName } : {}),
      enabled: v.enabled,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath(`/clients/${v.clientId}/content`);
    return { status: "ok", id: row.id };
  } catch (error) {
    return failed(error, "Could not save the channel");
  }
}
