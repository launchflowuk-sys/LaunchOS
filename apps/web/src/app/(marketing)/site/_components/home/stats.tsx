import { Container, Lines } from "../primitives";

const STATS = [
  { value: 15, pad: 2, unit: "years", label: "Building for real businesses" },
  { value: 8, pad: 2, unit: "products", label: "Created in-house" },
  { value: 1, pad: 2, unit: "partner", label: "From design to ongoing care" },
] as const;

/** Under a hairline: one line, three figures that count up the first time they are seen. */
export function Stats() {
  return (
    <section aria-label="LaunchFlow in numbers" className="hairline">
      <Container className="grid gap-10 py-16 sm:py-20 lg:grid-cols-12 lg:gap-8">
        <h2 className="h-sub lg:col-span-4" data-reveal>
          <Lines first="Small studio." second="Big on doing the work." secondClass="quiet" />
        </h2>
        <dl className="grid gap-8 sm:grid-cols-3 lg:col-span-8">
          {STATS.map((stat) => (
            <div key={stat.unit} className="border-t border-[var(--line)] pt-5" data-reveal>
              <dt className="sr-only">{stat.label}</dt>
              <dd className="flex items-baseline gap-2">
                <span className="figure" data-count={stat.value} data-pad={stat.pad}>
                  {String(stat.value).padStart(stat.pad, "0")}
                </span>
                <span className="text-lg text-[var(--mute)]">{stat.unit}</span>
              </dd>
              <dd className="body mt-2 text-[0.9375rem]" aria-hidden>
                {stat.label}
              </dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
