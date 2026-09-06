import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import satori from "satori";
import sharp from "sharp";
import { z } from "zod";

/**
 * The branded graphic every post can fall back on: Satori lays the text out as
 * SVG, Sharp rasterises it to PNG. No network, no API key, no cost — which is
 * why this, not the image generator, is the default.
 */

const require_ = createRequire(import.meta.url);

/**
 * Satori reads `.ttf`, `.otf` and `.woff`, and **not** `.woff2`, so point at
 * the `.woff` files Fontsource ships alongside them. Geist keeps these
 * graphics in the same voice as the marketing site.
 */
const FONT_FILES = {
  400: "@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff",
  600: "@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff",
} as const;

const FONT_FAMILY = "Geist";

type LoadedFont = { name: string; data: Buffer; weight: 400 | 600; style: "normal" };
let fonts: LoadedFont[] | undefined;

/**
 * Loaded once and kept — the worker draws many posts a month and the files do
 * not change between them. A moved or renamed file is a loud failure at the
 * first render rather than a graphic with invisible text, which is the failure
 * nobody would notice until a client did.
 */
function loadFonts(): LoadedFont[] {
  if (fonts) return fonts;
  fonts = Object.entries(FONT_FILES).map(([weight, specifier]) => {
    try {
      return {
        name: FONT_FAMILY,
        data: readFileSync(require_.resolve(specifier)),
        weight: Number(weight) as 400 | 600,
        style: "normal" as const,
      };
    } catch (cause) {
      throw new Error(
        `Cannot load the template font ${specifier}. @fontsource/geist-sans must ship .woff files under files/ — check the installed version, and remember Satori cannot read .woff2.`,
        { cause },
      );
    }
  });
  return fonts;
}

export const IMAGE_TEMPLATE_SIZES = ["square", "landscape"] as const;
export type ImageTemplateSize = (typeof IMAGE_TEMPLATE_SIZES)[number];

interface Layout {
  width: number;
  height: number;
  padding: number;
  kickerSize: number;
  ruleWidth: number;
  ruleHeight: number;
  wordmarkSize: number;
  logoHeight: number;
  gap: number;
  /** Headline sizes tried largest first. Fixed steps, so one headline always lands on the same size. */
  headlineSizes: readonly number[];
}

/** 1080×1080 for Facebook, Instagram and GBP; 1200×630 for a blog card. */
const LAYOUTS: Readonly<Record<ImageTemplateSize, Layout>> = {
  square: {
    width: 1080, height: 1080, padding: 88, kickerSize: 26, ruleWidth: 104, ruleHeight: 8,
    wordmarkSize: 34, logoHeight: 64, gap: 44, headlineSizes: [132, 116, 102, 90, 78, 68, 58, 50, 44],
  },
  landscape: {
    width: 1200, height: 630, padding: 64, kickerSize: 22, ruleWidth: 88, ruleHeight: 6,
    wordmarkSize: 28, logoHeight: 48, gap: 30, headlineSizes: [92, 82, 72, 63, 55, 48, 42, 36, 32],
  },
};

/** Tight, the way a poster is set. Multiplies the font size to give the line box. */
const LINE_HEIGHT = 1.06;

/**
 * Rough advance widths in em for Geist at weight 600. Satori will not tell us
 * how wide a string came out, so the size is chosen from an estimate — and the
 * estimate deliberately runs wide (see `SAFETY`), because over-estimating costs
 * one step of font size while under-estimating clips the headline.
 */
const NARROW = new Set("ijl|!.,;:'`");
const THIN = new Set("ft()[]{}-/\\rI");
const WIDE = new Set("mw");
const EXTRA_WIDE = new Set("MW@%");
const SAFETY = 1.05;

function charWidth(char: string): number {
  if (char === " ") return 0.26;
  if (NARROW.has(char)) return 0.29;
  if (THIN.has(char)) return 0.35;
  if (EXTRA_WIDE.has(char)) return 0.95;
  if (WIDE.has(char)) return 0.87;
  if (char >= "0" && char <= "9") return 0.58;
  if (char >= "A" && char <= "Z") return 0.69;
  return 0.56;
}

/** Estimated pixel width of a single line of headline. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const char of text) em += charWidth(char);
  return em * fontSize * SAFETY;
}

/**
 * Greedy word wrap against the estimate. A single word wider than the column is
 * broken mid-word so the loop always terminates — a 300-character headline with
 * no spaces in it still has to land somewhere.
 */
export function wrapHeadline(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = () => {
    if (line) lines.push(line);
    line = "";
  };

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
      line = candidate;
      continue;
    }
    push();
    let rest = word;
    while (rest.length > 1 && estimateTextWidth(rest, fontSize) > maxWidth) {
      let cut = rest.length - 1;
      while (cut > 1 && estimateTextWidth(rest.slice(0, cut), fontSize) > maxWidth) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  push();
  return lines;
}

/**
 * The largest step that fits the column. If even the smallest step needs more
 * lines than there is room for, the headline is cut to the lines that do fit and
 * ellipsised — text running off the canvas looks like a bug, a trimmed sentence
 * looks like a decision.
 */
function fitHeadline(text: string, layout: Layout, maxWidth: number, maxHeight: number): { fontSize: number; lines: string[] } {
  for (const fontSize of layout.headlineSizes) {
    const lines = wrapHeadline(text, fontSize, maxWidth);
    if (lines.length * fontSize * LINE_HEIGHT <= maxHeight) return { fontSize, lines };
  }
  const fontSize = layout.headlineSizes[layout.headlineSizes.length - 1]!;
  const allowed = Math.max(1, Math.floor(maxHeight / (fontSize * LINE_HEIGHT)));
  const lines = wrapHeadline(text, fontSize, maxWidth).slice(0, allowed);
  lines[lines.length - 1] = `${lines[lines.length - 1]!.replace(/[\s.,;:]+$/, "")}…`;
  return { fontSize, lines };
}

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "use a six-digit hex colour such as #0969ca");

export const RenderTemplateImageInput = z.object({
  /** Trimmed from the post body by the caller; the only text set large. */
  headline: z.string().trim().min(1).max(400),
  /** The client's town, or "Offer" — small, above the rule. */
  kicker: z.string().trim().max(60).optional(),
  wordmark: z.string().trim().min(1).max(60),
  logo: z.object({ bytes: z.instanceof(Uint8Array), mime: z.string().min(1).max(100) }).optional(),
  brand: z.object({ primary: Hex, accent: Hex }),
  size: z.enum(IMAGE_TEMPLATE_SIZES),
});
export type RenderTemplateImageInput = z.input<typeof RenderTemplateImageInput>;

export interface RenderedTemplateImage {
  /** Backed by a plain ArrayBuffer, so it hands straight to `createContentAsset`. */
  bytes: Uint8Array<ArrayBuffer>;
  mime: "image/png";
}

/** A plain object tree; Satori's JSX runtime is not worth pulling into core for one layout. */
type Node = { type: string; props: Record<string, unknown> };
const node = (type: string, props: Record<string, unknown>): Node => ({ type, props });

/**
 * White ink on the brand ground unless the ground is pale, in which case the
 * ink goes dark. Relative luminance the WCAG way, so a client who picks a
 * yellow still gets a legible headline.
 */
function inkOn(hex: string): string {
  const channel = (from: number) => {
    const c = Number.parseInt(hex.slice(from, from + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.45 ? "#0b0f18" : "#ffffff";
}

/** Width ÷ height of the supplied logo, so it scales to the footer height undistorted. */
async function logoAspect(bytes: Uint8Array): Promise<number> {
  try {
    const { width, height } = await sharp(Buffer.from(bytes)).metadata();
    if (width && height) return width / height;
  } catch {
    // An unreadable logo must not lose the whole graphic: a square box is a fair
    // guess and the post still goes out branded.
  }
  return 1;
}

/**
 * Draws the post's picture: brand ground, an accent rule under a small kicker,
 * the headline set large and tight, the logo or wordmark bottom-left. One
 * layout, two aspects, deterministic and entirely offline.
 */
export async function renderTemplateImage(input: RenderTemplateImageInput): Promise<RenderedTemplateImage> {
  const v = RenderTemplateImageInput.parse(input);
  const layout = LAYOUTS[v.size];
  const ink = inkOn(v.brand.primary);
  const contentWidth = layout.width - layout.padding * 2;

  // What the headline may occupy: the canvas less its padding, the header
  // (kicker, its gap and the rule), the footer, and the gap either side.
  const headerHeight = (v.kicker ? layout.kickerSize * 1.3 + 18 : 0) + layout.ruleHeight;
  const footerHeight = v.logo ? layout.logoHeight : Math.round(layout.wordmarkSize * 1.3);
  const headlineHeight = layout.height - layout.padding * 2 - headerHeight - footerHeight - layout.gap * 2;
  const { fontSize, lines } = fitHeadline(v.headline, layout, contentWidth, headlineHeight);

  const footer = v.logo
    ? node("img", {
        src: `data:${v.logo.mime};base64,${Buffer.from(v.logo.bytes).toString("base64")}`,
        height: layout.logoHeight,
        width: Math.round(layout.logoHeight * (await logoAspect(v.logo.bytes))),
        style: { objectFit: "contain" },
      })
    : node("div", {
        style: { display: "flex", fontSize: layout.wordmarkSize, fontWeight: 600, color: ink, letterSpacing: "-0.01em", opacity: 0.92 },
        children: v.wordmark,
      });

  const header = node("div", {
    style: { display: "flex", flexDirection: "column" },
    children: [
      ...(v.kicker
        ? [node("div", {
            style: {
              display: "flex", fontSize: layout.kickerSize, fontWeight: 600, letterSpacing: "0.14em",
              textTransform: "uppercase", color: v.brand.accent, marginBottom: 18,
            },
            children: v.kicker,
          })]
        : []),
      node("div", { style: { display: "flex", width: layout.ruleWidth, height: layout.ruleHeight, backgroundColor: v.brand.accent } }),
    ],
  });

  const tree = node("div", {
    style: {
      display: "flex", flexDirection: "column", justifyContent: "space-between",
      width: layout.width, height: layout.height, padding: layout.padding,
      backgroundColor: v.brand.primary, fontFamily: FONT_FAMILY, color: ink,
    },
    children: [
      header,
      // One div per line: the wrap is already decided above, so what was measured
      // is what is drawn and Satori is never left to re-wrap into an extra line.
      node("div", {
        style: {
          display: "flex", flexDirection: "column", width: contentWidth,
          fontSize, fontWeight: 600, lineHeight: LINE_HEIGHT, letterSpacing: "-0.02em",
        },
        children: lines.map((line) => node("div", { style: { display: "flex" }, children: line })),
      }),
      node("div", { style: { display: "flex", alignItems: "flex-end", height: footerHeight }, children: footer }),
    ],
  });

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: layout.width,
    height: layout.height,
    fonts: loadFonts(),
  });
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  return { bytes: new Uint8Array(png), mime: "image/png" };
}
