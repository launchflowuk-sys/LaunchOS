import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const UpdateKnowledgeArticleInput = z.object({
  articleId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  bodyMd: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  published: z.boolean().optional(),
});
export type UpdateKnowledgeArticleInput = z.input<typeof UpdateKnowledgeArticleInput>;

export async function updateKnowledgeArticle(db: Db, organisationId: string, input: UpdateKnowledgeArticleInput) {
  const { articleId, ...patch } = UpdateKnowledgeArticleInput.parse(input);
  await assertOwned(db, organisationId, schema.knowledgeArticles, articleId);
  const where = and(eq(schema.knowledgeArticles.id, articleId), eq(schema.knowledgeArticles.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.knowledgeArticles).where(where);
    const [after] = await tx
      .update(schema.knowledgeArticles)
      .set({ ...patch, updatedAt: new Date() })
      .where(where)
      .returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: "user", action: "knowledge_article.updated", targetType: "knowledge_article", targetId: articleId, before, after,
    });
    return after!;
  });
}
