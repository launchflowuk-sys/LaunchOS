import type { SiteThumbnail } from "@launchos/core";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The picture of a site, or an honest empty slot.
 *
 * Whether there is an image is decided on the server from `hasImage`, not by
 * letting an `<img>` 404 and catching `onError` — that would need a client
 * component per row and would flash a broken-image icon on every site that has
 * never been captured, which on a fresh install is all of them.
 *
 * A plain `<img>` rather than `next/image`: the bytes come from our own
 * session-guarded route, they are already thumbnail-sized, and the optimiser
 * would add a second fetch and a cache of resized copies for no gain.
 * `loading="lazy"` is what keeps a list of forty sites from opening forty
 * connections at once.
 */
export function SiteThumb({
  siteId,
  name,
  thumbnail,
  className,
}: {
  siteId: string;
  name: string;
  thumbnail: SiteThumbnail | undefined;
  className?: string;
}) {
  const frame = cn(
    "relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-[14px] border bg-muted",
    className,
  );

  if (!thumbnail?.hasImage) {
    return (
      <div className={frame}>
        <div className="flex flex-col items-center gap-1.5 px-3 text-center">
          <ImageOff aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.75} />
          <p className="text-meta text-muted-foreground">
            {thumbnail?.failureReason ? "Could not be captured" : "No picture yet"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={frame}>
      <img
        src={`/api/websites/${siteId}/thumbnail`}
        alt={`Screenshot of ${name}`}
        loading="lazy"
        decoding="async"
        // Top-anchored: a homepage is read from the top, and centring the crop
        // would cut the header off every site in the list.
        className="size-full object-cover object-top"
      />
      {/* A picture that is still there but is known to be stale says so, rather
          than quietly showing last week's homepage as if it were today's. */}
      {thumbnail.failureReason ? (
        <span className="absolute right-2 bottom-2 rounded-full bg-warning-solid px-2 py-0.5 text-[0.6875rem] font-semibold text-white">
          Stale
        </span>
      ) : null}
    </div>
  );
}
