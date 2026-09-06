import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { CONTACT_EMAIL } from "@/lib/marketing/site";
import { Btn, Container, Eyebrow, TextLink } from "./primitives";

/**
 * The closing invitation: the big blue rounded panel with the drifting
 * arrow. On the home page and at the foot of every inner page, so the copy
 * comes in as props and the panel itself never changes.
 */
export function CtaBlock({
  eyebrow = "Have something in mind?",
  title,
  body,
  primary,
  note = "A few lines is plenty. Shoji replies within one working day.",
}: {
  eyebrow?: string;
  title: ReactNode;
  body: string;
  primary: { label: string; href: string };
  note?: string;
}) {
  return (
    <section aria-label="Get in touch" className="pb-20 sm:pb-28">
      <Container>
        <div className="cta-panel relative overflow-hidden rounded-[1.75rem] bg-[var(--blue)] px-6 py-12 text-white sm:px-12 sm:py-16 lg:px-16 lg:py-20" data-reveal>
          <ArrowUpRight
            aria-hidden
            strokeWidth={0.6}
            className="drift pointer-events-none absolute -right-8 -top-10 hidden size-[22rem] text-white/20 lg:block xl:size-[26rem]"
          />
          <div className="relative grid gap-10 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-7">
              <Eyebrow line className="text-white/85">
                {eyebrow}
              </Eyebrow>
              <h2 className="h-section mt-5 text-white">{title}</h2>
              <p className="mt-6 max-w-[48ch] text-lg leading-relaxed text-white/85">{body}</p>
              <div className="mt-8">
                <Btn href={primary.href} tone="white-solid" size="lg">
                  {primary.label}
                </Btn>
              </div>
              <p className="mt-4 text-sm text-white/80">{note}</p>
            </div>
            <div className="lg:col-span-5 lg:justify-self-end lg:text-right">
              <TextLink href={`mailto:${CONTACT_EMAIL}`} external tone="white" className="text-lg">
                {CONTACT_EMAIL}
              </TextLink>
              <p className="mt-2 text-sm text-white/80">Based in Grays, Essex. Building for businesses across the UK.</p>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
