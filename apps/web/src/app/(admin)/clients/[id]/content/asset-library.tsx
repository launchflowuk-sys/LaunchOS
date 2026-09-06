"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AssetGrid, type AssetTile, assetLabel } from "@/components/asset-grid";
import { ImageUploadForm } from "@/components/image-upload-form";
import { Button } from "@/components/ui/button";
import { deleteContentAssetAction } from "./actions";

/**
 * The client's image library on their Content tab: upload, the grid, and a
 * per-tile delete that warns first. Deleting is a hard delete of the file —
 * a scheduled post still pointing at it fails at publish time — so the
 * confirmation says exactly that rather than "are you sure?".
 */
export function AssetLibrary({ clientId, assets }: { clientId: string; assets: readonly AssetTile[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [removing, setRemoving] = useState<string | null>(null);

  function remove(asset: AssetTile) {
    const confirmed = window.confirm(
      `Delete "${assetLabel(asset)}"? Any scheduled post that uses this image will fail to publish until it is given another one.`,
    );
    if (!confirmed) return;
    setRemoving(asset.id);
    startTransition(async () => {
      const result = await deleteContentAssetAction({ clientId, assetId: asset.id });
      setRemoving(null);
      if (result.status === "error") return void toast.error(result.message);
      toast.success("Photo deleted");
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
        empty="No photos yet. Add the client's own photos — of the shop, the team, the work — and the writer picks from them."
        renderActions={(asset) => (
          <Button
            type="button"
            variant="destructive-quiet"
            size="sm"
            className="w-full"
            loading={pending && removing === asset.id}
            disabled={pending}
            onClick={() => remove(asset)}
            aria-label={`Delete ${assetLabel(asset)}`}
          >
            Delete
          </Button>
        )}
      />
    </div>
  );
}
