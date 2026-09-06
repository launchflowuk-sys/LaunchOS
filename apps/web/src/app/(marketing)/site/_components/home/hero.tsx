import { ArrowUpRight, Check } from "lucide-react";
import Image from "next/image";
import { STUDIO_EYEBROW } from "@/lib/marketing/site";
import { findWork } from "@/lib/marketing/work";
import { Btn, Container, Eyebrow, TextLink } from "../primitives";

/** A line break in the headline. */
const BREAK = "<br>";

const HEADLINE: readonly { word: string; accent?: boolean }[] = [
  { word: "Built" },
  { word: "to" },
  { word: "work." },
  { word: BREAK },
  { word: "Designed" },
  { word: "to" },
  { word: BREAK },
  { word: "stand", accent: true },
  { word: "out.", accent: true },
];

/** The two screenshots in the stack, back to front. Real projects, real captures. */
const STACK = [
  { slug: "grays-cabline", rotate: "-6deg", depth: 8, className: "left-[6%] top-[10%] w-[78%]", float: "float" },
  { slug: "star-grooming", rotate: "3deg", depth: 14, className: "right-[4%] bottom-[16%] w-[70%]", float: "float float-late" },
] as const;

/**
 * Two columns, 60/40. The headline rises a word at a time on load; the
 * right-hand panel holds two of our own screenshots stacked like paper,
 * floating on a slow loop and drifting a little with the mouse on a desktop.
 * Nothing here waits for script: the words and the panel animate from the
 * first paint.
 */
export function Hero({ contactHref, workHref }: { contactHref: string; workHref: string }) {
  let wordIndex = 0;
  return (
    <section aria-labelledby="hero-title" className="overflow-hidden">
      <Container className="grid gap-12 pt-14 pb-16 sm:pt-20 lg:grid-cols-[3fr_2fr] lg:items-center lg:gap-16 lg:pt-24 lg:pb-24">
        <div>
          <Eyebrow line className="hero-in" as="p">
            {STUDIO_EYEBROW}
          </Eyebrow>
          <h1 id="hero-title" className="h-display mt-6">
            {HEADLINE.map((part, i) => {
              if (part.word === BREAK) return <br key={i} />;
              const style = { "--i": wordIndex++ } as React.CSSProperties;
              const spaceAfter = i < HEADLINE.length - 1 && HEADLINE[i + 1]?.word !== BREAK;
              return (
                <span key={i}>
                  <span className={part.accent ? "hw accent" : "hw"} style={style}>
                    {part.word}
                  </span>
                  {spaceAfter ? " " : null}
                </span>
              );
            })}
          </h1>
          <p className="lede hero-in mt-7 text-lg" style={{ "--d": "520ms" } as React.CSSProperties}>
            Websites, apps and software for businesses with somewhere to go. Designed, built and looked after by LaunchFlow.
          </p>
          <div className="hero-in hero-actions mt-9 flex flex-row flex-wrap items-center gap-x-4 gap-y-3 sm:gap-5" style={{ "--d": "640ms" } as React.CSSProperties}>
            <Btn href={contactHref} tone="blue" size="lg">
              Let&rsquo;s build something
            </Btn>
            <TextLink href={workHref} kind="right" className="text-[0.9375rem]">
              Explore our work
            </TextLink>
          </div>
          <p className="hero-in mt-8 flex items-center gap-2.5 text-sm text-[var(--mute-2)]" style={{ "--d": "760ms" } as React.CSSProperties}>
            <span className="grid size-5 place-items-center rounded-full bg-[var(--tint)] text-[var(--blue)]">
              <Check aria-hidden className="size-3" strokeWidth={3} />
            </span>
            Real experience. From the first idea to everyday use.
          </p>
        </div>

        <div className="hero-in" style={{ "--d": "300ms" } as React.CSSProperties}>
          <HeroStack />
        </div>
      </Container>
    </section>
  );
}

function HeroStack() {
  return (
    <div data-parallax className="relative aspect-[5/6] w-full rounded-[1.75rem] bg-[var(--tint)] sm:aspect-[4/4.4] lg:aspect-[5/6]">
      <p className="eyebrow absolute left-6 top-6 z-10 text-[var(--mute-2)]">A little of what we do</p>

      {STACK.map((layer, index) => {
        const item = findWork(layer.slug);
        if (!item?.screenshots.desktop) return null;
        return (
          <div key={layer.slug} className={`plx absolute ${layer.className}`} style={{ "--depth": layer.depth } as React.CSSProperties}>
            <div className={layer.float}>
              <div className="overflow-hidden rounded-xl border border-white/70 bg-white p-1.5 shadow-[0_24px_48px_-24px_rgba(20,27,41,0.35)]" style={{ transform: `rotate(${layer.rotate})` }}>
                <div className="shot border-0">
                  <Image
                    src={item.screenshots.desktop}
                    alt={`${item.name} website`}
                    width={1440}
                    height={900}
                    sizes="(min-width: 1024px) 30vw, 70vw"
                    priority={index === 0}
                    quality={78}
                  />
                </div>
                <span className="pill absolute bottom-4 left-4 shadow-sm">{item.name}</span>
              </div>
            </div>
          </div>
        );
      })}

      <div className="plx absolute bottom-6 left-6 z-10" style={{ "--depth": 20 } as React.CSSProperties}>
        <div className="bob flex max-w-[15rem] items-start gap-3 rounded-2xl border border-[var(--line)] bg-white p-4 shadow-[0_16px_40px_-20px_rgba(20,27,41,0.3)]">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--ink)] text-white">
            <ArrowUpRight aria-hidden className="size-4" strokeWidth={2} />
          </span>
          <p className="h-line leading-snug">From a great idea. To a real-world business.</p>
        </div>
      </div>
    </div>
  );
}
