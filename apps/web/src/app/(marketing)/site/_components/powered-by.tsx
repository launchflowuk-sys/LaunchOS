import Image from "next/image";
import type { PoweredBy } from "@/lib/marketing/work";
import { cn } from "@/lib/utils";

/**
 * "Powered by Cabio" — the credit a project carries when it runs on one of
 * our own platforms. On a card it is plain text: the card is already a
 * link and an anchor inside an anchor is not valid HTML. On the brief it
 * links out, because there the reader may well want the platform itself.
 */
export function PoweredByBadge({ platform, linked = false, className }: { platform: PoweredBy; linked?: boolean; className?: string }) {
  const classes = cn("powered", className);
  const content = (
    <>
      <span>Powered by</span>
      <Image src={platform.logo} alt={platform.name} width={platform.logoWidth} height={platform.logoHeight} sizes="120px" />
    </>
  );
  if (!linked) {
    return (
      <span className={classes} aria-label={`Powered by ${platform.name}`}>
        {content}
      </span>
    );
  }
  return (
    <a href={platform.url} rel="noopener" className={classes} aria-label={`Powered by ${platform.name}`}>
      {content}
    </a>
  );
}
