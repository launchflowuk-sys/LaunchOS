"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AssetGrid, type AssetTile, assetLabel } from "@/components/asset-grid";
import { Button } from "@/components/ui/button";
import { pickContentImageAction } from "../actions";

/**
 * "Pick an image" on a post: the client's library, with the image the post
 * currently carries outlined. Choosing one sets `image_url` to the asset's
 * public URL through the same `updateContentItem` the editor uses, so a
 * draft stays a draft and a rejected one returns to draft as usual.
 */
export function ImagePicker({
  itemId,
  clientId,
  currentImageUrl,
  assets,
}: {
  itemId: string;
  clientId: string;
  currentImageUrl: string | null;
  assets: readonly AssetTile[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picking, setPicking] = useState<string | null>(null);
  const current = assets.find((asset) => asset.url === currentImageUrl)?.id ?? null;

  function pick(asset: AssetTile) {
    setPicking(asset.id);
    startTransition(async () => {
      const result = await pickContentImageAction({ itemId, assetId: asset.id });
      setPicking(null);
      if (result.status === "error") return void toast.error(result.message);
      toast.success(`Using "${assetLabel(asset)}"`);
      router.refresh();
    });
  }

  return (
    <AssetGrid
      assets={assets}
      selectedId={current}
      empty={
        <>
          No photos in this client&rsquo;s library yet. Add some on their{" "}
          <a href={`/clients/${clientId}/content`} className="text-primary underline underline-offset-2">
            Content tab
          </a>
          , or paste a public image URL above.
        </>
      }
      renderActions={(asset) =>
        current === asset.id ? (
          <p className="text-center text-meta font-medium text-primary">In use</p>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            loading={pending && picking === asset.id}
            disabled={pending}
            onClick={() => pick(asset)}
            aria-label={`Use ${assetLabel(asset)}`}
          >
            Use this image
          </Button>
        )
      }
    />
  );
}
