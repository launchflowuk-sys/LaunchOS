import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { STARTER_GUIDES } from "./starter-guides.js";

/**
 * Puts a guide on every screen, once, for an organisation that has none.
 *
 * Insert-only on the slug. A guide Shoji has edited, published or deleted is
 * never written over — the same rule `ensureAgentsEnabled` follows, and for the
 * same reason: a deploy must not undo somebody's decision.
 *
 * They arrive **unpublished**. That is deliberate and it is what he asked for:
 * these describe the software accurately but know nothing about how he actually
 * works, and a guide is the one kind of writing where nearly right is worse
 * than absent — somebody will follow it. Help coverage shows how many are
 * waiting, and publishing is one press per guide from there.
 */
export async function ensureStarterGuides(
  db: Db,
  organisationId: string,
): Promise<{ added: number }> {
  const added = await db
    .insert(schema.knowledgeArticles)
    .values(
      STARTER_GUIDES.map((guide) => ({
        organisationId,
        title: guide.title,
        slug: guide.slug,
        bodyMd: guide.body,
        routes: [guide.route],
        audiences: [...guide.audiences],
        tags: ["how-to"],
        published: false,
      })),
    )
    .onConflictDoNothing({ target: [schema.knowledgeArticles.organisationId, schema.knowledgeArticles.slug] })
    .returning({ id: schema.knowledgeArticles.id });

  return { added: added.length };
}
