"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { reorderCaseStudiesAction } from "./actions";

/**
 * Up and down, not drag and drop.
 *
 * The Work page is ordered on a phone as often as at a desk — DESIGN.md's
 * first rule is that every screen works at 375px — and drag-to-reorder on a
 * touch screen fights the page scroll, needs a library, and is unusable with a
 * keyboard or a screen reader. Two buttons are none of those things.
 *
 * The whole order is sent rather than a swap, because that is what
 * `reorderCaseStudies` takes: ids not named keep their `sort` and land after
 * the named ones, which is what a partial reorder should do.
 */
export function ReorderControls({ ids, index }: { ids: readonly string[]; index: number }) {
  const [pending, start] = useTransition();

  const move = (to: number) => {
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved!);
    start(async () => {
      const result = await reorderCaseStudiesAction(next);
      if (result.status === "error") return void toast.error(result.message);
      toast.success("Order saved");
    });
  };

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Move up"
        disabled={pending || index === 0}
        onClick={() => move(index - 1)}
      >
        <ArrowUp aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Move down"
        disabled={pending || index === ids.length - 1}
        onClick={() => move(index + 1)}
      >
        <ArrowDown aria-hidden />
      </Button>
    </span>
  );
}
