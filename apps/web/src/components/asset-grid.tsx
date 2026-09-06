import { Images } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";

/** What a tile needs: the public URL, a label and a size. The row type is core's `listContentAssets` element. */
export type AssetTile = {
  id: string;
  url: string;
  alt: string | null;
  originalName: string | null;
  sizeBytes: number;
  source: "client" | "staff" | "generated";
};

/** "1.2 MB", "340 KB" — enough precision to spot the photo that will be slow to load. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function assetLabel(asset: Pick<AssetTile, "alt" | "originalName">): string {
  return asset.alt || asset.originalName || "Untitled photo";
}

/**
 * Thumbnails in a responsive grid: two across on a phone, up to five on a
 * desktop. Each tile is the image, its name, its size, and whatever the
 * caller renders underneath (a delete button, a "Use this image" button).
 *
 * Plain `<img>` on purpose: the URLs are this app's own `/api/assets/<id>`
 * route, and `next/image` would need the host listed for what is already a
 * cached, immutable file.
 */
export function AssetGrid({
  assets,
  renderActions,
  empty,
  selectedId,
}: {
  assets: readonly AssetTile[];
  renderActions?: (asset: AssetTile) => ReactNode;
  empty: ReactNode;
  /** The tile to outline — the image a post currently carries. */
  selectedId?: string | null;
}) {
  if (assets.length === 0) return <EmptyState icon={Images}>{empty}</EmptyState>;
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Photos">
      {assets.map((asset) => (
        <li
          key={asset.id}
          className={cn(
            "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card",
            selectedId === asset.id && "border-primary ring-2 ring-primary/30",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- our own immutable asset route; see above */}
          <img src={asset.url} alt={asset.alt ?? ""} loading="lazy" className="aspect-square w-full object-cover" />
          <div className="min-w-0 space-y-0.5 p-2">
            <p className="truncate text-row font-medium" title={assetLabel(asset)}>
              {assetLabel(asset)}
            </p>
            <p className="truncate text-meta text-muted-foreground tabular-nums">
              {formatBytes(asset.sizeBytes)}
              {asset.source === "client" ? " · from the client" : null}
            </p>
            {renderActions ? <div className="pt-1.5">{renderActions(asset)}</div> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
