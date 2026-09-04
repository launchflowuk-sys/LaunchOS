import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, isNull } from "drizzle-orm";

export interface ListKnowledgeArticlesInput {
  includeUnpublished?: boolean;
}

export async function listKnowledgeArticles(db: Db, organisationId: string, input: ListKnowledgeArticlesInput = {}) {
  const conditions = [eq(schema.knowledgeArticles.organisationId, organisationId), isNull(schema.knowledgeArticles.deletedAt)];
  if (!input.includeUnpublished) conditions.push(eq(schema.knowledgeArticles.published, true));
  return db.select().from(schema.knowledgeArticles).where(and(...conditions)).orderBy(asc(schema.knowledgeArticles.title));
}
