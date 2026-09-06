import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";

const SIZES = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

/**
 * A screenshot in a thin frame, or — when the capture script found nothing
 * for this project — a placeholder that says the name rather than showing a
 * broken image. The frame reserves its aspect ratio either way so the grid
 * does not jump as images arrive. `chip` adds the small round ↗ that marks a
 * card as a link; `inner` wraps it in the tinted inner frame.
 */
export function Shot({
  src,
  alt,
  name,
  kind = "desktop",
  sizes = "(min-width: 1024px) 50vw, 100vw",
  priority = false,
  chip = false,
  inner = false,
  className,
}: {
  src: string | undefined;
  alt: string;
  /** Shown in the placeholder. */
  name: string;
  kind?: "desktop" | "mobile";
  sizes?: string;
  priority?: boolean;
  chip?: boolean;
  inner?: boolean;
  className?: string;
}) {
  const frame = cn("shot", kind === "mobile" && "shot-mobile", className);
  const body = src ? (
    <div className={frame}>
      <Image src={src} alt={alt} width={SIZES[kind].width} height={SIZES[kind].height} sizes={sizes} priority={priority} quality={80} />
      {chip ? (
        <span className="shot-chip" aria-hidden>
          <ArrowUpRight className="arrow size-4" strokeWidth={2} />
        </span>
      ) : null}
    </div>
  ) : (
    <div className={cn(frame, "shot-placeholder")} role="img" aria-label={`${name} — no screenshot yet`}>
      <p className="h-sub accent">{name}</p>
    </div>
  );
  return inner ? <div className="shot-inner">{body}</div> : body;
}
