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
 * does not jump as images arrive.
 */
export function Shot({
  src,
  alt,
  name,
  kind = "desktop",
  sizes = "(min-width: 1024px) 50vw, 100vw",
  priority = false,
  className,
}: {
  src: string | undefined;
  alt: string;
  /** Shown in the placeholder. */
  name: string;
  kind?: "desktop" | "mobile";
  sizes?: string;
  priority?: boolean;
  className?: string;
}) {
  const frame = cn("shot", kind === "mobile" && "shot-mobile", className);
  if (!src) {
    return (
      <div className={cn(frame, "flex items-end p-5")} role="img" aria-label={`${name} — no screenshot yet`}>
        <p className="display text-2xl text-primary sm:text-3xl">{name}</p>
      </div>
    );
  }
  const { width, height } = SIZES[kind];
  return (
    <div className={frame}>
      <Image src={src} alt={alt} width={width} height={height} sizes={sizes} priority={priority} quality={80} />
    </div>
  );
}
