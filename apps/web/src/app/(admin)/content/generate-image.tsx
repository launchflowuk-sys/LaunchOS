"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { renderContentImageAction } from "./actions";

type Mode = "auto" | "template" | "ai";

/** The three ways to ask, in the order they read: the client's own setting, then the two overrides. */
const MODE_LABEL: Record<Mode, string> = {
  auto: "As the brief says",
  template: "Branded graphic",
  ai: "AI photograph",
};

/**
 * How long to wait before re-reading the page. The work happens in the worker,
 * so nothing on screen changes when the button returns; a template render there
 * is well under a second, and this leaves room for the queue round trip without
 * making the operator wonder whether the press landed.
 */
const REFRESH_AFTER_MS = 3500;

/**
 * "Generate image", and the same control as "Regenerate" once a post has one.
 *
 * The dropdown and the button sit together because they are one decision: how
 * this post's picture gets drawn. A branded graphic is free; a photograph costs
 * money and is capped monthly by core, which falls back to a graphic when the
 * budget is spent rather than leaving the post with nothing.
 *
 * The press queues the work rather than doing it, so the button reports that
 * honestly and then re-reads the page once the worker has had time to finish.
 */
export function GenerateImage({
  itemId,
  hasImage,
  clientOptedInToAi,
  className,
}: {
  itemId: string;
  /** Drives the button's word, and whether the render is allowed to replace what is there. */
  hasImage: boolean;
  /** Whether this client's brief asks for photography — what "As the brief says" will do. */
  clientOptedInToAi: boolean;
  className?: string;
}) {
  const router = useRouter();
  const selectId = useId();
  const [mode, setMode] = useState<Mode>("auto");
  const [pending, startTransition] = useTransition();
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A refresh fired after the editor has been closed would set state on a gone
  // component; clearing on unmount is the whole reason the handle is kept.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function generate() {
    startTransition(async () => {
      const result = await renderContentImageAction({ itemId, mode, force: hasImage });
      if (result.status === "error") return void toast.error(result.message);
      toast.success(result.message);
      setWaiting(true);
      timer.current = setTimeout(() => {
        setWaiting(false);
        router.refresh();
      }, REFRESH_AFTER_MS);
    });
  }

  const busy = pending || waiting;

  return (
    <div className={className}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 space-y-1.5 sm:w-56">
          <Label htmlFor={selectId}>How to draw it</Label>
          <NativeSelect
            id={selectId}
            value={mode}
            disabled={busy}
            onChange={(event) => setMode(event.target.value as Mode)}
          >
            {(Object.keys(MODE_LABEL) as Mode[]).map((key) => (
              <option key={key} value={key}>
                {MODE_LABEL[key]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="button" variant="secondary" loading={busy} disabled={busy} onClick={generate} className="max-sm:w-full">
          {hasImage ? "Regenerate image" : "Generate image"}
        </Button>
      </div>
      <p className="mt-2 text-meta text-muted-foreground">
        {waiting
          ? "The worker is drawing it. This page re-reads itself in a moment."
          : mode === "auto"
          ? clientOptedInToAi
            ? "This client's brief asks for AI photography, so that is what will be drawn — a branded graphic if the month's budget is spent."
            : "This client's brief asks for branded graphics, which are free. Change it on their Content tab, or pick a photograph above for this post only."
          : mode === "template"
            ? "A branded graphic in the client's colours: the headline, their wordmark, no cost."
            : "A generated photograph. It costs money, is capped monthly, and falls back to a branded graphic when the cap is reached."}
        {hasImage && !waiting ? " Regenerating replaces the picture the post carries now." : null}
      </p>
    </div>
  );
}
