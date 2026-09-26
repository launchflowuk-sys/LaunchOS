/**
 * CPU over the last 24h, as a plain inline SVG — no chart library, renders
 * server-side. `apps/web/src/components/sparkline.tsx` exists but normalises
 * to its own min/max, which would draw an idle 3% server the same height as a
 * pegged 95% one; this one is fixed to a 0–100% scale so the shape is
 * comparable across the whole fleet at a glance.
 */
export function Sparkline({ values, max = 100 }: { values?: number[] | null | undefined; max?: number }) {
  if (!values?.length) return <span className="text-meta text-muted-foreground">—</span>;
  const w = 44;
  const h = 24;
  const top = Math.max(max, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - (v / top) * h}`).join(" ");
  const last = values.at(-1)!;
  return (
    <span className="inline-flex items-center gap-1.5" title={`CPU last 24h, now ${last}%`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
      </svg>
      <span className="text-meta tabular-nums">{last}%</span>
    </span>
  );
}
