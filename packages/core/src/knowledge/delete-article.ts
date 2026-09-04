import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const DeleteKnowledgeArticleInput = z.object({
  articleId: z.string().uuid(),
  // Audit actor: who soft-deleted it.
  actorId: z.string().optional(),
});
export type DeleteKnowledgeArticleInput = z.input<typeof DeleteKnowledgeArticleInput>;

/**
 * Soft delete only: the row stays put so an agent run that cited this article
 * still resolves the reference, but it drops out of search and listings.
 */
export async function deleteKnowledgeArticle(db: Db, organisationId: string, input: DeleteKnowledgeArticleInput): Promise<void> {
  const { articleId, actorId } = DeleteKnowledgeArticleInput.parse(input);
  await assertOwned(db, organisationId, schema.knowledgeArticles, articleId);
  // `assertOwned` has no soft-delete filter, so the `isNull` here is what makes
  // the delete terminal: a direct POST carrying a deleted article's id finds no
  // row and is reported as missing rather than silently re-writing it.
  const where = and(
    eq(schema.knowledgeArticles.id, articleId),
    eq(schema.knowledgeArticles.organisationId, organisationId),
    isNull(schema.knowledgeArticles.deletedAt),
  );

  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.knowledgeArticles).where(where);
    const [after] = await tx
      .update(schema.knowledgeArticles)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(where)
      .returning();
    if (!after) throw new Error(`knowledge_article ${articleId} not found in organisation`);
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: "user", actorId, action: "knowledge_article.deleted", targetType: "knowledge_article", targetId: articleId, before, after,
    });
  });
}
