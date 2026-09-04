import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const CreateKnowledgeArticleInput = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).optional(),
  bodyMd: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  published: z.boolean().default(false),
  // The admin who wrote it, forwarded to the audit row. Optional so non-request
  // callers (seed, agent tools) still work; the web action always passes it.
  actorId: z.string().optional(),
});
export type CreateKnowledgeArticleInput = z.input<typeof CreateKnowledgeArticleInput>;

// Named for the barrel: `clients/slug.js` already exports a `slugify` of its
// own (different length cap and diacritics handling), so this one needs a
// distinct name to be re-exported from `index.ts` without a collision.
export function slugifyArticleTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200) || "article";
}

/** Appends -2, -3 … until the (organisation, slug) unique index is satisfied. */
async function uniqueSlug(db: Db, organisationId: string, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [clash] = await db
      .select({ id: schema.knowledgeArticles.id })
      .from(schema.knowledgeArticles)
      .where(and(eq(schema.knowledgeArticles.organisationId, organisationId), eq(schema.knowledgeArticles.slug, candidate)));
    if (!clash) return candidate;
  }
  throw new Error(`could not find a free slug for "${base}"`);
}

export async function createKnowledgeArticle(db: Db, organisationId: string, input: CreateKnowledgeArticleInput) {
  const { actorId, ...v } = CreateKnowledgeArticleInput.parse(input);
  // Uniqueness is only checked, not reserved, so this stays outside the
  // transaction — same shape as `uniqueClientSlug` ahead of `createClient`'s
  // transaction.
  const slug = await uniqueSlug(db, organisationId, slugifyArticleTitle(v.slug ?? v.title));

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [created] = await tx
      .insert(schema.knowledgeArticles)
      .values({ organisationId, title: v.title, slug, bodyMd: v.bodyMd, tags: v.tags, published: v.published })
      .returning();
    await recordAudit(inner, organisationId, {
      actorKind: "user", actorId, action: "knowledge_article.created", targetType: "knowledge_article", targetId: created!.id, after: created,
    });
    return created!;
  });
}
