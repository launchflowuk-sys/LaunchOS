import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const DeleteKnowledgeArticleInput = z.object({
  articleId: z.string().uuid(),
});
export type DeleteKnowledgeArticleInput = z.input<typeof DeleteKnowledgeArticleInput>;

/**
 * Soft delete only: the row stays put so an agent run that cited this article
 * still resolves the reference, but it drops out of search and listings.
 */
export async function deleteKnowledgeArticle(db: Db, organisationId: string, input: DeleteKnowledgeArticleInput): Promise<void> {
  const { articleId } = DeleteKnowledgeArticleInput.parse(input);
  await assertOwned(db, organisationId, schema.knowledgeArticles, articleId);
  const where = and(eq(schema.knowledgeArticles.id, articleId), eq(schema.knowledgeArticles.organisationId, organisationId));

  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.knowledgeArticles).where(where);
    const [after] = await tx
      .update(schema.knowledgeArticles)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(where)
      .returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: "user", action: "knowledge_article.deleted", targetType: "knowledge_article", targetId: articleId, before, after,
    });
  });
}
