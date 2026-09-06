import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * The LaunchFlow wordmark. One component so the three places it appears — the
 * admin rail, the portal top bar and `/sign-in` — cannot drift in size, source
 * or alt text.
 *
 * The 585px transparent PNG is the source at every size: it is the @2x asset
 * for the ~120px lockup this product uses, so a retina screen has real pixels
 * to draw and `next/image` still serves a resized copy to a phone.
 *
 * It is transparent (cut from the original export on 6 Sep 2026, soft edge
 * kept), so it sits on white, off-white and the marketing header directly.
 * Its lettering is navy, so on the navy admin rail it still goes inside
 * `BrandTile`, a deliberate white chip. The opaque `launchflow-logo@600.png`
 * stays for Open Graph previews, which need a solid ground.
 */
const INTRINSIC = { width: 585, height: 126 } as const;

/** The lockup width DESIGN.md pins: ~120px wide, so ~29px tall. */
export const BRAND_MARK_WIDTH = 120;

export function BrandMark({
  width = BRAND_MARK_WIDTH,
  className,
  priority = false,
}: {
  width?: number;
  className?: string;
  /** True on `/sign-in`, where the wordmark is the largest thing above the fold. */
  priority?: boolean;
}) {
  return (
    <Image
      src="/brand/launchflow-logo-transparent@600.png"
      alt="LaunchFlow"
      width={width}
      height={Math.round((width * INTRINSIC.height) / INTRINSIC.width)}
      priority={priority}
      className={cn("h-auto w-auto", className)}
      style={{ width, height: "auto" }}
    />
  );
}

/**
 * The wordmark on a chip, because the asset has a white ground of its own (see
 * above). The navy rail and the nav sheet need it to sit on white at all;
 * `/sign-in` uses it so the asset's ground reads as a deliberate lockup rather
 * than a pale rectangle on the cool off-white page.
 */
export function BrandTile({
  width = BRAND_MARK_WIDTH,
  className,
  priority = false,
}: {
  width?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center rounded-lg bg-white px-2.5 py-2", className)}>
      <BrandMark width={width} priority={priority} />
    </span>
  );
}
