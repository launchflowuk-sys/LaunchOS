import { z } from "zod";
import { formatDate, formatPence } from "@/lib/format";

/**
 * Where a post's picture came from, said out loud.
 *
 * Core writes `content_items.metadata.image` whenever it draws one. It is read
 * back through a schema rather than trusted: a post whose image was picked from
 * the library has no `image` key at all, and a half-written one must read as
 * "we do not know" on the page rather than throw on the page that shows it.
 */
export const ContentImageMetadata = z.object({
  mode: z.enum(["template", "ai"]),
  model: z.string(),
  costPence: z.number().int().min(0),
  assetId: z.string(),
  generatedAt: z.string(),
  prompt: z.string().optional(),
  fellBackFrom: z.enum(["monthly_cap", "no_prompt", "generator_refused"]).optional(),
});
export type ContentImageMetadata = z.infer<typeof ContentImageMetadata>;

/** `content_items.metadata.image` — core's `IMAGE_METADATA_KEY`, repeated here so no server import reaches the browser. */
const IMAGE_KEY = "image";

/** `content_briefs.metadata.images` — core's `BRIEF_IMAGES_METADATA_KEY`, where a client opts in to photography. */
const BRIEF_IMAGES_KEY = "images";

export const BRIEF_IMAGE_MODES = ["template", "ai"] as const;
export type BriefImageMode = (typeof BRIEF_IMAGE_MODES)[number];

const BriefImageSettings = z.object({ mode: z.enum(BRIEF_IMAGE_MODES).optional() });

/**
 * What this client's brief asks for. Branded graphics unless they have said
 * otherwise — the same reading core does, so the form shows what will happen
 * rather than what was typed, and a half-written opt-in reads as "no".
 */
export function briefImageMode(metadata: Record<string, unknown> | null | undefined): BriefImageMode {
  const raw = metadata?.[BRIEF_IMAGES_KEY];
  if (!raw || typeof raw !== "object") return "template";
  const parsed = BriefImageSettings.safeParse(raw);
  return parsed.success && parsed.data.mode === "ai" ? "ai" : "template";
}

/** How the two ways of drawing a picture read on screen, everywhere. */
export const IMAGE_MODE_LABEL: Record<ContentImageMetadata["mode"], string> = {
  template: "Branded graphic",
  ai: "AI photograph",
};

/** Why a request for AI came back with a graphic, in one clause. */
const FELL_BACK: Record<NonNullable<ContentImageMetadata["fellBackFrom"]>, string> = {
  monthly_cap: "the month's image budget was already spent",
  no_prompt: "the writer left no prompt to generate from",
  generator_refused: "the image generator refused",
};

export function readImageMetadata(metadata: Record<string, unknown> | null | undefined): ContentImageMetadata | null {
  const raw = metadata?.[IMAGE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const parsed = ContentImageMetadata.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** "4p" reads better than "£0.04" for money this small, and nothing spent says so plainly. */
export function formatImageCost(pence: number): string {
  if (pence <= 0) return "free";
  return pence < 100 ? `${pence}p` : formatPence(pence);
}

/**
 * One line under a post's picture: "Generated · AI photograph · 4p · 2 Sep 2026".
 *
 * Every screen that shows the image shows this, so nobody has to wonder whether
 * a photograph was the client's own or ours — and, when AI was asked for and a
 * graphic came back, why.
 */
export function ImageProvenance({
  metadata,
  imageUrl,
  className,
}: {
  metadata: Record<string, unknown> | null | undefined;
  imageUrl: string | null;
  className?: string;
}) {
  const classes = className ? `text-meta text-muted-foreground ${className}` : "text-meta text-muted-foreground";
  if (!imageUrl) return <p className={classes}>No image yet.</p>;

  const image = readImageMetadata(metadata);
  if (!image) return <p className={classes}>From the photo library — not generated.</p>;

  return (
    <p className={classes}>
      Generated · {IMAGE_MODE_LABEL[image.mode]} · {formatImageCost(image.costPence)} · {formatDate(image.generatedAt)}
      {image.fellBackFrom ? <> · asked for a photograph, drew a graphic because {FELL_BACK[image.fellBackFrom]}</> : null}
    </p>
  );
}
