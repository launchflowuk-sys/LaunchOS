import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";

/** `clients.metadata.brand` — no column, no migration, exactly like `organisations.metadata.booking`. */
export const BRAND_METADATA_KEY = "brand";

/** LaunchFlow's own ink and blue: a sensible ground for a client who has told us nothing yet. */
export const DEFAULT_BRAND_PRIMARY = "#141b29";
export const DEFAULT_BRAND_ACCENT = "#0969ca";

/**
 * Six-digit hex only. Lower-cased on the way in so the same colour typed two
 * ways compares equal in the audit trail and in the picker.
 */
const Hex = z.string().trim().toLowerCase().regex(/^#[0-9a-f]{6}$/, "use a six-digit hex colour such as #0969ca");

/**
 * What is actually stored. Every field is optional: an unset field falls back
 * to a default that may depend on the client row (the wordmark does), so the
 * stored shape must be able to say "nothing chosen" rather than repeat a
 * default that would then go stale when the client is renamed.
 */
export const ClientBrandSchema = z.object({
  primary: Hex.optional(),
  accent: Hex.optional(),
  logoAssetId: z.string().uuid().optional(),
  wordmark: z.string().trim().min(1).max(60).optional(),
});
export type ClientBrand = z.infer<typeof ClientBrandSchema>;

/** The brand with every blank filled in — what the renderer is handed. */
export interface ResolvedClientBrand {
  primary: string;
  accent: string;
  logoAssetId: string | null;
  wordmark: string;
}

type BrandableClient = Pick<typeof schema.clients.$inferSelect, "name" | "tradingName" | "metadata">;

/**
 * The stored brand merged over the defaults. A corrupt or half-written value
 * reads as the defaults rather than throwing: a bad colour in jsonb must never
 * be able to stop a post being drawn.
 */
export function clientBrandFrom(client: BrandableClient): ResolvedClientBrand {
  const raw = client.metadata?.[BRAND_METADATA_KEY];
  const stored = raw && typeof raw === "object" ? ClientBrandSchema.safeParse(raw) : null;
  const brand = stored?.success ? stored.data : {};
  return {
    primary: brand.primary ?? DEFAULT_BRAND_PRIMARY,
    accent: brand.accent ?? DEFAULT_BRAND_ACCENT,
    logoAssetId: brand.logoAssetId ?? null,
    wordmark: brand.wordmark ?? client.tradingName ?? client.name,
  };
}

/** The stored brand exactly as it sits in metadata — what `setClientBrand` merges into. */
function storedBrandOf(client: BrandableClient): ClientBrand {
  const raw = client.metadata?.[BRAND_METADATA_KEY];
  if (!raw || typeof raw !== "object") return {};
  const parsed = ClientBrandSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

async function loadClient(db: Db, organisationId: string, clientId: string): Promise<BrandableClient> {
  const [client] = await db
    .select({ name: schema.clients.name, tradingName: schema.clients.tradingName, metadata: schema.clients.metadata })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  // Same sentence `assertOwned` uses, so a cross-organisation read and a
  // cross-organisation write fail identically to the caller.
  if (!client) throw new Error(`client ${clientId} not found in organisation`);
  return client;
}

export const GetClientBrandInput = z.object({ clientId: z.string().uuid() });
export type GetClientBrandInput = z.input<typeof GetClientBrandInput>;

export async function getClientBrand(db: Db, organisationId: string, input: GetClientBrandInput): Promise<ResolvedClientBrand> {
  const v = GetClientBrandInput.parse(input);
  return clientBrandFrom(await loadClient(db, organisationId, v.clientId));
}

/**
 * A field sent as `null` or `""` is cleared back to its default; a field left
 * out is untouched. The colour inputs on the Content tab post the whole brand,
 * but the "use this image as the logo" tile posts only `logoAssetId`, so a
 * partial merge is the only shape that serves both.
 */
export const SetClientBrandInput = z.object({
  clientId: z.string().uuid(),
  primary: Hex.nullish(),
  accent: Hex.nullish(),
  logoAssetId: z.string().uuid().nullish(),
  wordmark: z.string().trim().max(60).nullish(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type SetClientBrandInput = z.input<typeof SetClientBrandInput>;

export type ClientRow = typeof schema.clients.$inferSelect;

/** Drops the key when the patch clears it, sets it when the patch supplies it, leaves it alone otherwise. */
function mergeField<K extends keyof ClientBrand>(into: ClientBrand, key: K, value: ClientBrand[K] | null | undefined): ClientBrand {
  if (value === undefined) return into;
  if (value === null || value === "") {
    // Rebuilt without the key rather than set to null, so the stored object
    // only ever holds choices the client has actually made.
    return Object.fromEntries(Object.entries(into).filter(([k]) => k !== key)) as ClientBrand;
  }
  return { ...into, [key]: value };
}

/**
 * Writes `clients.metadata.brand`. The metadata object read out is never
 * mutated — a fresh brand object is built and merged into the column with
 * jsonb `||`, so a concurrent write to another metadata key survives.
 */
export async function setClientBrand(db: Db, organisationId: string, input: SetClientBrandInput): Promise<ClientRow> {
  const v = SetClientBrandInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);

  if (v.logoAssetId) {
    // The logo has to be one of this client's own images: an asset id arriving
    // from a form is outside the trust boundary, and the renderer would happily
    // draw another client's logo onto this client's post.
    const [asset] = await db
      .select({ id: schema.contentAssets.id })
      .from(schema.contentAssets)
      .where(and(
        eq(schema.contentAssets.id, v.logoAssetId),
        eq(schema.contentAssets.organisationId, organisationId),
        eq(schema.contentAssets.clientId, v.clientId),
        isNull(schema.contentAssets.deletedAt),
      ))
      .limit(1);
    if (!asset) throw new Error(`content asset ${v.logoAssetId} is not one of this client's images`);
  }

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const where = and(eq(schema.clients.id, v.clientId), eq(schema.clients.organisationId, organisationId));
    const [before] = await tx.select().from(schema.clients).where(where);
    let brand = storedBrandOf(before!);
    brand = mergeField(brand, "primary", v.primary);
    brand = mergeField(brand, "accent", v.accent);
    brand = mergeField(brand, "logoAssetId", v.logoAssetId);
    brand = mergeField(brand, "wordmark", v.wordmark);

    const [after] = await tx.update(schema.clients)
      .set({
        metadata: sql`coalesce(${schema.clients.metadata}, '{}'::jsonb) || ${JSON.stringify({ [BRAND_METADATA_KEY]: brand })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(where)
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "client.brand_updated",
      targetType: "client", targetId: v.clientId, before: storedBrandOf(before!), after: brand,
    });
    return after!;
  });
}
