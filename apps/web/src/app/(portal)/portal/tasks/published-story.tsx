import { listCaseStudies } from "@launchos/core";
import { ArrowUpRight } from "lucide-react";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { marketingHost } from "@/lib/env";

/**
 * "We wrote about your project."
 *
 * Only when it is actually published. A draft is our working copy — every
 * project opens one on the day it starts — and showing a client a link to a
 * story they cannot read, or worse a half-written one, is the opposite of the
 * point. `status: "published"` is the whole filter, and `unlisted` is
 * deliberately excluded: a story we chose not to advertise is not one to
 * announce in the portal either.
 *
 * The link is absolute on the marketing host, because the portal is served
 * from the app host and a relative `/work/...` there is a 404.
 */
export async function PublishedStory({ organisationId, clientId }: { organisationId: string; clientId: string }) {
  const stories = await listCaseStudies(getDb(), organisationId, { clientId, status: "published", limit: 5 });
  if (stories.length === 0) return null;

  return (
    <Section title="Your story on our site" description="We wrote up what we built for you. Have a read, and tell us if anything is wrong.">
      <ul className="grid gap-3">
        {stories.map((story) => (
          <li key={story.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div className="min-w-0">
              <p className="text-base font-semibold">{story.name}</p>
              {story.summary ? <p className="mt-0.5 text-sm text-muted-foreground">{story.summary}</p> : null}
            </div>
            <Button asChild variant="secondary" size="lg" className="w-full shrink-0 sm:w-auto">
              <a href={`https://${marketingHost()}/work/${story.slug}`} rel="noopener" target="_blank">
                Read it
                <ArrowUpRight aria-hidden />
              </a>
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
