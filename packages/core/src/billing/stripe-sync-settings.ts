import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

/** Where the Stripe sync keeps its state inside `organisations.metadata`. */
export const STRIPE_SYNC_METADATA_KEY = "stripeSync";

const NamedRow = z.object({ id: z.string(), name: z.string() });

/** What one run did — the Settings → Billing card and the import result page both render this. */
export const StripeSyncSummary = z.object({
  at: z.string(),
  trigger: z.enum(["import", "reconcile", "webhook"]),
  packages: z.object({ created: z.array(NamedRow), linked: z.array(NamedRow) }),
  clients: z.object({
    created: z.array(NamedRow),
    matched: z.number().int(),
    /** Existing clients the owner chose on the review screen ("File under"). Absent on summaries stored before it existed. */
    filed: z.array(NamedRow).default([]),
  }),
  subscriptions: z.object({
    created: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
    /**
     * Cancelled subscriptions of customers LaunchOS has never seen (history
     * with nobody to file it under), and customers another organisation's
     * billing profile already claims.
     */
    skipped: z.number().int(),
  }),
  statusChanges: z.array(z.object({
    subscriptionId: z.string(),
    clientId: z.string(),
    clientName: z.string(),
    from: z.string(),
    to: z.string(),
  })),
});
export type StripeSyncSummary = z.infer<typeof StripeSyncSummary>;

export const StripeSyncSettings = z.object({
  /** Catalogue products the owner chose not to import — Cabio's, the test product. */
  ignoredProductIds: z.array(z.string()).default([]),
  lastRunAt: z.string().optional(),
  lastSummary: StripeSyncSummary.optional(),
});
export type StripeSyncSettings = z.infer<typeof StripeSyncSettings>;

export const DEFAULT_STRIPE_SYNC_SETTINGS: StripeSyncSettings = { ignoredProductIds: [] };

/** Reads what is stored, tolerating a missing or half-written object. */
export function stripeSyncSettingsFrom(metadata: Record<string, unknown> | null | undefined): StripeSyncSettings {
  const raw = metadata?.[STRIPE_SYNC_METADATA_KEY];
  const parsed = StripeSyncSettings.safeParse(typeof raw === "object" && raw !== null ? raw : {});
  return parsed.success ? parsed.data : DEFAULT_STRIPE_SYNC_SETTINGS;
}

export async function getStripeSyncSettings(db: Db, organisationId: string): Promise<StripeSyncSettings> {
  const [organisation] = await db
    .select({ metadata: schema.organisations.metadata })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  return stripeSyncSettingsFrom(organisation?.metadata);
}

/**
 * Merges `patch` into `metadata.stripeSync`, leaving every other metadata key
 * (assignment rules, say) alone. Not audited: this is the sync's own
 * bookkeeping, and the run that produced it audits every business write.
 */
export async function setStripeSyncSettings(
  db: Db,
  organisationId: string,
  patch: Partial<StripeSyncSettings>,
): Promise<StripeSyncSettings> {
  const before = await getStripeSyncSettings(db, organisationId);
  const after: StripeSyncSettings = StripeSyncSettings.parse({ ...before, ...patch });
  const [row] = await db
    .update(schema.organisations)
    .set({
      metadata: sql`coalesce(${schema.organisations.metadata}, '{}'::jsonb)
        || jsonb_build_object(${STRIPE_SYNC_METADATA_KEY}::text, ${JSON.stringify(after)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.organisations.id, organisationId))
    .returning({ id: schema.organisations.id });
  if (!row) throw new Error(`organisation ${organisationId} not found`);
  return after;
}

/**
 * The one active organisation, when there is exactly one. The Stripe webhook
 * route resolves tenancy through `billing_profiles.stripe_customer_id`, which
 * a customer LaunchOS has never seen cannot satisfy; with a single tenant
 * running there is only one place such an event could belong. Null the
 * moment a second active organisation exists — then nothing is guessed.
 */
export async function soleActiveOrganisationId(db: Db): Promise<string | null> {
  const rows = await db
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .where(eq(schema.organisations.status, "active"))
    .orderBy(asc(schema.organisations.createdAt))
    .limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}
