"use server";

import { createKnowledgeArticle, deleteKnowledgeArticle, updateKnowledgeArticle } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

/**
 * The shape the admin server actions return. Declared here rather than
 * imported from another module's `schemas.ts` so the Knowledge Base stays
 * independent of the task screens, exactly as `tasks/schemas.ts` describes.
 */
export type ActionResult = { status: "ok" } | { status: "error"; message: string };

const ArticleFields = z.object({
  title: z.string().trim().min(1).max(200),
  bodyMd: z.string().trim().min(1),
  tags: z.string().trim(),
  // An unchecked checkbox is simply absent from the FormData, so `null` is the
  // "off" case rather than a validation failure.
  published: z.union([z.literal("on"), z.null()]).transform((v) => v === "on"),
});

type ArticleValues = { title: string; bodyMd: string; tags: string[]; published: boolean };

const INVALID = "Give the article a title and a body.";

function parse(formData: FormData): { ok: true; value: ArticleValues } | { ok: false; message: string } {
  const parsed = ArticleFields.safeParse({
    title: formData.get("title"),
    bodyMd: formData.get("bodyMd"),
    tags: formData.get("tags") ?? "",
    published: formData.get("published"),
  });
  if (!parsed.success) return { ok: false, message: INVALID };
  const { tags, ...rest } = parsed.data;
  return {
    ok: true,
    value: { ...rest, tags: tags.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0) },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * Bound straight to a `<form action>` so the browser follows the redirect to
 * the article it just created. A failure comes back on the form's own route as
 * `?error=`, which the page renders — never the error boundary.
 */
export async function createArticleAction(formData: FormData): Promise<void> {
  // Server Actions accept direct POSTs, so authorise before reading anything.
  const session = await requireAdmin();
  const fields = parse(formData);
  if (!fields.ok) redirect(`/knowledge/new?error=${encodeURIComponent(fields.message)}`);

  let articleId: string;
  try {
    const article = await createKnowledgeArticle(getDb(), session.organisationId, fields.value);
    articleId = article.id;
  } catch (error) {
    redirect(`/knowledge/new?error=${encodeURIComponent(messageOf(error))}`);
  }

  revalidatePath("/knowledge");
  redirect(`/knowledge/${articleId}`);
}

const ArticleId = z.object({ articleId: z.string().uuid() });

/** Saves in place, so it returns a result the `ActionForm` wrapper can toast. */
export async function updateArticleAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const target = ArticleId.safeParse({ articleId: formData.get("articleId") });
  if (!target.success) return { status: "error", message: "That article could not be identified" };
  const fields = parse(formData);
  if (!fields.ok) return { status: "error", message: fields.message };

  try {
    await updateKnowledgeArticle(getDb(), session.organisationId, {
      articleId: target.data.articleId,
      ...fields.value,
    });
    revalidatePath("/knowledge");
    revalidatePath(`/knowledge/${target.data.articleId}`);
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: messageOf(error) };
  }
}

/**
 * Soft-deletes and returns to the list. Core keeps the row so an agent run that
 * cited the article still resolves the reference.
 */
export async function deleteArticleAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const target = ArticleId.safeParse({ articleId: formData.get("articleId") });
  if (!target.success) redirect("/knowledge?error=That+article+could+not+be+identified");

  try {
    await deleteKnowledgeArticle(getDb(), session.organisationId, { articleId: target.data.articleId });
  } catch (error) {
    redirect(`/knowledge/${target.data.articleId}?error=${encodeURIComponent(messageOf(error))}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge");
}
