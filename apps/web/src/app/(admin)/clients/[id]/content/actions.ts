"use server";

import {
  BRIEF_IMAGES_METADATA_KEY, ContentRefused, deleteContentAsset, recordAudit, setClientBrand, setContentChannel,
  upsertContentBrief,
} from "@launchos/core";
import { schema } from "@launchos/db";
import { CompositeSocialPublisher, createSocialPublisherFromEnv, GbpPublisher, hasGbpCredentials, lookupInstagramForPage, SocialApiError, SocialAuthError } from "@launchos/integrations";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

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
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
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
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
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

/** A blank colour box clears the choice back to the default; anything else must be six-digit hex. */
const BrandColour = z.union([z.literal(""), z.string().trim().toLowerCase().regex(/^#[0-9a-f]{6}$/, "Use a six-digit hex colour such as #0969ca")]);

const BrandSchema = z.object({
  clientId: z.string().uuid(),
  primary: BrandColour,
  accent: BrandColour,
  wordmark: z.string().trim().max(60, "Keep the wordmark under 60 characters"),
  imageMode: z.enum(["template", "ai"]),
});

/**
 * How a client's post images look, and how they are made.
 *
 * Two writes, one button, because it reads as one decision. The colours and the
 * wordmark are `clients.metadata.brand`, which core owns; the opt-in is
 * `content_briefs.metadata.images.mode`, which no core service writes yet —
 * `upsertContentBrief` replaces the seven text fields and never touches
 * metadata, so this merges the one key itself with jsonb `||` and audits it,
 * the same shape `setAgentEnabled` uses. The brand write runs first: it asserts
 * the client belongs to this organisation, so a forged id never reaches the
 * brief.
 */
export async function saveClientBrandAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = BrandSchema.safeParse({
    clientId: value(formData, "clientId"),
    primary: value(formData, "primary")?.trim() ?? "",
    accent: value(formData, "accent")?.trim() ?? "",
    wordmark: value(formData, "wordmark") ?? "",
    imageMode: value(formData, "imageMode") ?? "template",
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the brand and try again" };
  const v = parsed.data;

  try {
    const db = getDb();
    const client = await setClientBrand(db, session.organisationId, {
      clientId: v.clientId,
      // A blank box is "no choice made", which core stores as the key removed —
      // so a later change to a default, or a rename, is picked up rather than frozen.
      primary: v.primary || null,
      accent: v.accent || null,
      wordmark: v.wordmark || null,
      actorKind: "user",
      actorId: session.userId,
    });
    await setBriefImageMode(session.organisationId, session.userId, v.clientId, v.imageMode);
    revalidatePath(`/clients/${v.clientId}/content`);
    return { status: "ok", id: client.id };
  } catch (error) {
    return failed(error, "Could not save the brand");
  }
}

/** Merges the one metadata key, leaving every other key on the brief alone. */
async function setBriefImageMode(
  organisationId: string,
  userId: string,
  clientId: string,
  mode: "template" | "ai",
): Promise<void> {
  const db = getDb();
  const patch = JSON.stringify({ [BRIEF_IMAGES_METADATA_KEY]: { mode } });
  const where = and(
    eq(schema.contentBriefs.organisationId, organisationId),
    eq(schema.contentBriefs.clientId, clientId),
  );
  const [before] = await db.select().from(schema.contentBriefs).where(where);
  const [after] = await db
    .insert(schema.contentBriefs)
    .values({ organisationId, clientId, metadata: { [BRIEF_IMAGES_METADATA_KEY]: { mode } } })
    .onConflictDoUpdate({
      target: [schema.contentBriefs.organisationId, schema.contentBriefs.clientId],
      set: {
        metadata: sql`coalesce(${schema.contentBriefs.metadata}, '{}'::jsonb) || ${patch}::jsonb`,
        updatedAt: new Date(),
      },
    })
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: userId,
    action: before ? "content_brief.updated" : "content_brief.created",
    targetType: "content_brief",
    targetId: after!.id,
    before: before ?? null,
    after,
  });
}

const BrandLogoSchema = z.object({ clientId: z.string().uuid(), assetId: z.string().uuid().nullable() });

/**
 * "Use as logo" on a library tile, and the same button again to unset it.
 * Called from a button rather than a `<form action>` so the tile can report the
 * failure where the picture is. Core re-checks that the asset is one of this
 * client's own images before it stores the id.
 */
export async function setBrandLogoAction(values: { clientId: string; assetId: string | null }): Promise<ActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = BrandLogoSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: "That photo could not be identified" };

  try {
    const client = await setClientBrand(getDb(), session.organisationId, {
      clientId: parsed.data.clientId,
      logoAssetId: parsed.data.assetId,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}/content`);
    return { status: "ok", id: client.id };
  } catch (error) {
    return failed(error, "Could not set the logo");
  }
}

const DeleteAssetSchema = z.object({ clientId: z.string().uuid(), assetId: z.string().uuid() });

/**
 * Removes an image from the client's library — row and file. Called from a
 * button, not a `<form action>`, so the tile can confirm first and show the
 * failure. Core scopes the delete by organisation; a foreign id is "not
 * found" either way.
 */
export async function deleteContentAssetAction(values: { clientId: string; assetId: string }): Promise<ActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = DeleteAssetSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: "That photo could not be identified" };

  try {
    const removed = await deleteContentAsset(getDb(), session.organisationId, {
      assetId: parsed.data.assetId, actorKind: "user", actorId: session.userId,
    });
    if (!removed) return { status: "error", message: "That photo is already gone" };
    revalidatePath(`/clients/${parsed.data.clientId}/content`);
    revalidatePath("/portal/content");
    return { status: "ok", id: removed.id };
  } catch (error) {
    return failed(error, "Could not delete the photo");
  }
}

export type InstagramDetectResult =
  | { status: "found"; id: string; username: string | null }
  | { status: "none" }
  | { status: "error"; message: string };

const PageIdSchema = z.string().trim().min(1, "Enter the Facebook Page id first").max(200).regex(/^[\w.-]+$/, "That is not a Facebook Page id");

/**
 * "Detect from Facebook page": one Graph call for the Instagram Business
 * account connected to the Page, so the id lands in the form instead of
 * being dug out of Meta Business Suite. Reads nothing and writes nothing —
 * the row is saved by the ordinary channel form afterwards.
 */
export async function detectInstagramAction(values: { pageId: string }): Promise<InstagramDetectResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = PageIdSchema.safeParse(values.pageId);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Enter the Facebook Page id first" };

  try {
    const account = await lookupInstagramForPage(parsed.data, process.env);
    if (!account) return { status: "none" };
    return { status: "found", id: account.id, username: account.username };
  } catch (error) {
    if (error instanceof SocialAuthError && error.status === 0) {
      return { status: "error", message: "Waiting for Meta access: connect Meta (META_ADS_ACCESS_TOKEN and META_ADS_APP_SECRET) first." };
    }
    if (error instanceof SocialApiError || error instanceof TypeError) return { status: "error", message: error.message };
    console.error("Instagram lookup failed", error);
    return { status: "error", message: "Meta did not answer. Try again in a moment." };
  }
}

export type GbpLocationsResult =
  | { status: "found"; locations: { name: string; title: string; accountName: string }[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

/**
 * "Find my locations": every Business Profile location the connected Google
 * account manages, in the `accounts/…/locations/…` form the channel stores.
 * The adapter is selected the way the worker selects it — from the env, real
 * only when the three GBP keys are set — so an unconfigured deployment says
 * "waiting for Google API access" rather than listing a mock.
 */
export async function findGbpLocationsAction(): Promise<GbpLocationsResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  if (!hasGbpCredentials(process.env)) return { status: "unavailable" };

  try {
    const publisher = createSocialPublisherFromEnv(process.env);
    const gbp = publisher instanceof CompositeSocialPublisher ? publisher.for("gbp") : null;
    if (!(gbp instanceof GbpPublisher)) return { status: "unavailable" };
    const locations = await gbp.listLocations();
    return { status: "found", locations: locations.map(({ name, title, accountName }) => ({ name, title, accountName })) };
  } catch (error) {
    if (error instanceof SocialApiError) return { status: "error", message: error.message };
    console.error("GBP location lookup failed", error);
    return { status: "error", message: "Google did not answer. Try again in a moment." };
  }
}
