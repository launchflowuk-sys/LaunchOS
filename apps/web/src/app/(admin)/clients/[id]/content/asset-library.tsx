"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AssetGrid, type AssetTile, assetLabel } from "@/components/asset-grid";
import { ImageUploadForm } from "@/components/image-upload-form";
import { Button } from "@/components/ui/button";
import { deleteContentAssetAction, setBrandLogoAction } from "./actions";

/**
 * The client's image library on their Content tab: upload, the grid, a
 * per-tile delete that warns first, and the tile that is marked as the logo.
 *
 * The logo lives here rather than in the brand form because it *is* one of
 * these pictures — asking for it again in a file field would put the same
 * image in the library twice. The marked tile is outlined the same way the
 * post editor outlines the photo a post is using.
 *
 * Deleting is a hard delete of the file — a scheduled post still pointing at
 * it fails at publish time — so the confirmation says exactly that rather than
 * "are you sure?".
 */
export function AssetLibrary({
  clientId,
  assets,
  logoAssetId,
}: {
  clientId: string;
  assets: readonly AssetTile[];
  /** The image marked as this client's logo, drawn at the foot of a branded graphic. */
  logoAssetId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<{ id: string; job: "logo" | "delete" } | null>(null);

  function remove(asset: AssetTile) {
    const confirmed = window.confirm(
      `Delete "${assetLabel(asset)}"? Any scheduled post that uses this image will fail to publish until it is given another one.`,
    );
    if (!confirmed) return;
    setBusy({ id: asset.id, job: "delete" });
    startTransition(async () => {
      const result = await deleteContentAssetAction({ clientId, assetId: asset.id });
      setBusy(null);
      if (result.status === "error") return void toast.error(result.message);
      toast.success("Photo deleted");
      router.refresh();
    });
  }

  function setLogo(asset: AssetTile, isLogo: boolean) {
    setBusy({ id: asset.id, job: "logo" });
    startTransition(async () => {
      const result = await setBrandLogoAction({ clientId, assetId: isLogo ? null : asset.id });
      setBusy(null);
      if (result.status === "error") return void toast.error(result.message);
      toast.success(isLogo ? "Logo removed" : `"${assetLabel(asset)}" is now the logo`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <ImageUploadForm
          endpoint={`/api/clients/${clientId}/assets`}
          idPrefix="asset"
          ariaLabel="Add a photo"
          submitLabel="Add photo"
          altLabel="Alt text (optional)"
          altHint="What is in the picture, for the post and for screen readers."
          success="Photo added to the library"
        />
      </div>
      <AssetGrid
        assets={assets}
        selectedId={logoAssetId}
        empty="No photos yet. Add the client's own photos — of the shop, the team, the work — and the writer picks from them."
        renderActions={(asset) => {
          const isLogo = asset.id === logoAssetId;
          return (
            <div className="grid gap-1.5">
              <Button
                type="button"
                variant={isLogo ? "ghost" : "secondary"}
                size="sm"
                className="w-full"
                loading={pending && busy?.id === asset.id && busy.job === "logo"}
                disabled={pending}
                onClick={() => setLogo(asset, isLogo)}
                aria-label={isLogo ? `Stop using ${assetLabel(asset)} as the logo` : `Use ${assetLabel(asset)} as the logo`}
              >
                {isLogo ? "The logo — undo" : "Use as logo"}
              </Button>
              <Button
                type="button"
                variant="destructive-quiet"
                size="sm"
                className="w-full"
                loading={pending && busy?.id === asset.id && busy.job === "delete"}
                disabled={pending}
                onClick={() => remove(asset)}
                aria-label={`Delete ${assetLabel(asset)}`}
              >
                Delete
              </Button>
            </div>
          );
        }}
      />
    </div>
  );
}
