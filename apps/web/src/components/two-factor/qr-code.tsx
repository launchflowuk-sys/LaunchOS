"use client";

import { useMemo } from "react";
import { encode } from "uqr";

/**
 * The enrolment QR, drawn as one SVG path.
 *
 * Encoded in the browser rather than fetched: the string it carries is the
 * TOTP secret, and the round trip that would render it server-side is a round
 * trip that puts a live credential back on the wire for no gain. `uqr` has no
 * dependencies and no canvas, so this costs a few kilobytes.
 *
 * Black on white regardless of the surface. A QR reader needs the contrast and
 * the quiet border around the modules, so this is the one thing in the product
 * that does not take its colours from the palette; the white ground and the
 * padding are part of the code, not decoration.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const result = encode(value);
    const parts: string[] = [];
    for (let row = 0; row < result.size; row++) {
      for (let col = 0; col < result.size; col++) {
        if (result.data[row]![col]) parts.push(`M${col},${row}h1v1h-1z`);
      }
    }
    return { size: result.size, path: parts.join("") };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      className="size-44 shrink-0 rounded-lg border bg-white p-2 sm:size-48"
      shapeRendering="crispEdges"
    >
      <rect x={-2} y={-2} width={size + 4} height={size + 4} fill="#ffffff" />
      <path d={path} fill="#101020" />
    </svg>
  );
}
