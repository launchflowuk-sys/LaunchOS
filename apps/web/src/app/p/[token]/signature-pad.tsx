"use client";

import { Eraser, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Signing, drawn.
 *
 * Shoji's decision was click-to-accept plus **our own** recorded signature
 * rather than a third-party e-signature service, so this is the signature —
 * not a decorative flourish on top of a tickbox — and it is built to be used
 * with a finger on a phone first and a mouse second.
 *
 * Three things follow from that, and none of them is optional:
 *
 * - **Pointer events, not mouse events.** One code path covers finger, stylus
 *   and mouse, and `touch-action: none` on the canvas stops the browser
 *   scrolling the page out from under the stroke — the single reason most
 *   web signature boxes are unusable on a phone.
 * - **The strokes are the state, the canvas is a view of it.** Every point is
 *   kept in the signature's own coordinate space and the canvas is redrawn
 *   from them, so Undo, Clear, a rotated phone and a resized window all fall
 *   out of one `draw()` rather than out of four special cases over pixels
 *   that cannot be un-painted.
 * - **What is posted is SVG path data and nothing else.** Core accepts only
 *   the `d` attribute, matched against the SVG path grammar, and builds the
 *   `<svg>` around it itself: this signature ends up inside a document handed
 *   to Chromium, and a stranger's markup has no business there.
 */

/** Core's `SIGNATURE_VIEWBOX`. Every stored signature scales the same way. */
const VIEW_W = 600;
const VIEW_H = 200;

/** Core refuses past 100,000 characters; stop well short rather than lose the lot. */
const MAX_PATH_CHARS = 90_000;

type Point = readonly [number, number];

/** One decimal place is a tenth of a viewBox unit — finer than any pen leaves. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `M x y L x y …` per stroke. A single tap becomes a dot, thanks to the round cap. */
function pathOf(strokes: readonly (readonly Point[])[]): string {
  return strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const points = stroke.length === 1 ? [stroke[0]!, stroke[0]!] : stroke;
      return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${round(x)} ${round(y)}`).join(" ");
    })
    .join(" ");
}

export function SignaturePad({ name, label }: { name: string; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<readonly (readonly Point[])[]>([]);
  const drawing = useRef(false);

  const path = pathOf(strokes);
  const signed = strokes.some((stroke) => stroke.length > 0);

  /** Repaints the whole signature at the canvas's current device resolution. */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    // One transform takes the signature's own 600×200 space to the canvas, so
    // nothing below this line has to know how big the box happens to be.
    context.setTransform(canvas.width / VIEW_W, 0, 0, canvas.height / VIEW_H, 0, 0);
    context.strokeStyle = "#0f172a";
    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const stroke of strokes) {
      if (stroke.length === 0) continue;
      context.beginPath();
      const [firstX, firstY] = stroke[0]!;
      context.moveTo(firstX, firstY);
      for (const [x, y] of stroke.slice(1)) context.lineTo(x, y);
      if (stroke.length === 1) context.lineTo(firstX, firstY);
      context.stroke();
    }
  }, [strokes]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  /** A pointer position in the signature's coordinates, clamped to the box. */
  function pointFrom(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * VIEW_W;
    const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * VIEW_H;
    return [Math.min(Math.max(x, 0), VIEW_W), Math.min(Math.max(y, 0), VIEW_H)];
  }

  return (
    <div className="space-y-2">
      {/* Only the heading sits above the box, and it never changes.
          Anything that changes as the signature is drawn — the state, the
          buttons coming alive — goes *below* it, because a line that rewraps
          on the first stroke moves the box up under the finger drawing it,
          and every point after that lands in the wrong place. */}
      <span className="h-line block">{label}</span>

      <div className="relative overflow-hidden rounded-xl border-2 border-dashed" style={{ borderColor: "var(--line)", background: "var(--paper)" }}>
        {/* The rule and the cross are what make this read as a place to sign
            rather than as a blank panel. Both are behind the canvas and take
            no pointer events, so neither can swallow a stroke. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-6 bottom-8 flex items-end gap-2">
          <span className="text-lg leading-none" style={{ color: "var(--mute)" }}>
            ✕
          </span>
          <span className="h-px flex-1" style={{ background: "var(--line)" }} />
        </div>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={signed ? "Your signature" : "An empty signing box — draw your signature here"}
          className="relative block w-full cursor-crosshair touch-none select-none"
          style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
          onPointerDown={(event) => {
            if (path.length > MAX_PATH_CHARS) return;
            // Capture keeps the stroke coming to the canvas when the pen
            // wanders off the box mid-signature. It is a nicety, not the
            // mechanism — and it throws on a pointer the browser no longer
            // considers active — so losing it must not lose the stroke.
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // Nothing to do: the handlers below work without it.
            }
            drawing.current = true;
            const point = pointFrom(event);
            setStrokes((current) => [...current, [point]]);
          }}
          onPointerMove={(event) => {
            if (!drawing.current || path.length > MAX_PATH_CHARS) return;
            const point = pointFrom(event);
            setStrokes((current) => {
              const last = current[current.length - 1];
              if (!last) return current;
              return [...current.slice(0, -1), [...last, point]];
            });
          }}
          onPointerUp={() => {
            drawing.current = false;
          }}
          onPointerCancel={() => {
            drawing.current = false;
          }}
          onPointerLeave={() => {
            drawing.current = false;
          }}
        />
      </div>

      <input type="hidden" name={name} value={path} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm" style={{ color: signed ? undefined : "var(--mute)" }}>
          {signed ? "Signed" : "Use your finger or your mouse"}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className="btn btn-white"
            disabled={!signed}
            onClick={() => setStrokes((current) => current.slice(0, -1))}
          >
            <Undo2 aria-hidden className="size-4" /> Undo
          </button>
          <button type="button" className="btn btn-white" disabled={!signed} onClick={() => setStrokes([])}>
            <Eraser aria-hidden className="size-4" /> Clear
          </button>
        </div>
      </div>
    </div>
  );
}
