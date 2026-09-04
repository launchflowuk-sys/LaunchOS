/**
 * A small trend line, drawn as inline SVG on purpose: no chart library, no
 * client JavaScript, and it renders identically in the printable invoice and
 * report pages. Values are plotted left to right, oldest first.
 */
export function Sparkline({
  values,
  label,
  width = 280,
  height = 48,
}: {
  values: number[];
  label: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <span className="text-xs text-neutral-400">Not enough data</span>;

  const max = Math.max(...values);
  const min = Math.min(...values);
  // A flat series would divide by zero and collapse the line onto the top edge;
  // a span of 1 draws it along the bottom instead, which reads as "no movement".
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map(
      (value, index) =>
        `${(index * step).toFixed(1)},${(height - ((value - min) / span) * height).toFixed(1)}`,
    )
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="text-neutral-900"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
