import { MAX_PUBLISHED_REVIEWS, publishableReviews } from "@launchos/core";
import type { schema } from "@launchos/db";
import { RefreshCw, Star } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatDateTime } from "@/lib/format";
import { refreshSiteReviewsAction, saveSiteReviewsAction } from "./actions";

/**
 * Google reviews for this site, and the switch that publishes them.
 *
 * Why two separate figures are shown: **ratings** is Google's
 * `user_ratings_total` — every star anybody has left — and **with a review to
 * show** is how many of those came with words attached. Places Details returns
 * at most five bodies however many hundreds of ratings a listing has, so a
 * panel printing one number would make a thriving business look as though it
 * has five reviews. The gap between the two is this feature's most likely bug,
 * and this is the screen where it stays visible.
 *
 * The failure line sits beside the last good data rather than replacing it,
 * because that is exactly what the stored row does: a listing that goes
 * unreadable keeps serving last week's reviews to the client's homepage. Both
 * things are true at once and the panel says both.
 */
export function ReviewsPanel({
  site,
  stored,
}: {
  site: typeof schema.sites.$inferSelect;
  stored: typeof schema.siteReviews.$inferSelect | null;
}) {
  const showable = stored ? publishableReviews(stored.reviews) : [];
  const atCeiling = stored !== null && stored.reviews.length >= MAX_PUBLISHED_REVIEWS;

  return (
    <div className="grid gap-4">
      <div className="rounded-[20px] border bg-card p-5">
        <ActionForm action={saveSiteReviewsAction} className="grid gap-4">
          <input type="hidden" name="siteId" value={site.id} />

          <div className="grid gap-1.5">
            <Label htmlFor="reviews-slug">Slug</Label>
            <Input
              id="reviews-slug"
              name="slug"
              defaultValue={site.slug ?? ""}
              placeholder="nasir-car-home"
              maxLength={120}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-meta break-all text-muted-foreground">
              What this website calls itself when it asks us for its reviews:{" "}
              <code>/api/public/reviews?site={site.slug ?? "…"}</code>
            </p>
            <p className="text-meta text-muted-foreground">
              One per website, not per client. A client with two websites has two Google listings, and a shared handle
              would serve the wrong one.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="reviews-place-id">Google place id</Label>
            <Input
              id="reviews-place-id"
              name="googlePlaceId"
              defaultValue={site.googlePlaceId ?? ""}
              placeholder="ChIJ…"
              maxLength={400}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-meta text-muted-foreground">
              From the client&rsquo;s claimed Google Business Profile. Typed in rather than looked up, because a wrong id
              publishes another company&rsquo;s reviews on their homepage.
            </p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl border bg-background px-4 py-3">
            <div className="min-w-0">
              <Label htmlFor="reviews-enabled" className="cursor-pointer">
                Serve these reviews publicly
              </Label>
              <p className="mt-0.5 text-meta text-muted-foreground">
                Off means the endpoint answers 404 and the client&rsquo;s band hides itself. Nothing is deleted.
              </p>
            </div>
            <Switch id="reviews-enabled" name="reviewsEnabled" value="true" defaultChecked={site.reviewsEnabled} />
          </div>

          <Button type="submit" className="justify-self-start max-sm:w-full">
            Save
          </Button>
        </ActionForm>
      </div>

      <div className="rounded-[20px] border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            {stored?.fetchedAt ? (
              <>
                <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                  <Star className="size-4 shrink-0 text-amber-500" aria-hidden />
                  {stored.rating ?? "—"} from {stored.count} {stored.count === 1 ? "rating" : "ratings"}
                  <span className="text-muted-foreground">
                    · {showable.length} with a review to show
                  </span>
                </p>
                <p className="mt-0.5 text-meta text-muted-foreground">
                  Read from Google {formatDateTime(stored.fetchedAt)}. Refreshed every morning at 05:10.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {site.googlePlaceId
                  ? "Never read successfully, so the endpoint answers 404 until one fetch works."
                  : "Add a place id above, then press Refresh."}
              </p>
            )}

            {stored?.failureReason ? (
              <p className="mt-2 text-sm text-destructive">
                Last attempt failed: {stored.failureReason}
                {stored.fetchedAt ? " — the reviews above are still being served." : ""}
              </p>
            ) : null}

            {atCeiling ? (
              <p className="mt-2 text-meta text-muted-foreground">
                At the {MAX_PUBLISHED_REVIEWS}-review ceiling. Google&rsquo;s Places API hands back five at most; more
                than that needs the client&rsquo;s own Business Profile sign-in.
              </p>
            ) : null}
          </div>

          <ActionForm action={refreshSiteReviewsAction} className="max-sm:w-full">
            <input type="hidden" name="siteId" value={site.id} />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={!site.googlePlaceId}
              className="max-sm:w-full"
            >
              <RefreshCw aria-hidden />
              Refresh now
            </Button>
          </ActionForm>
        </div>

        {showable.length > 0 ? (
          <ul className="mt-4 grid gap-3 border-t pt-4">
            {showable.map((review) => (
              <li key={`${review.time}-${review.author}`} className="min-w-0">
                <p className="text-meta text-muted-foreground">
                  <span aria-label={`${review.rating} out of 5`}>{"★".repeat(review.rating)}</span>
                  <span className="ml-2">{review.author}</span>
                  <span className="ml-2">
                    · {review.relativeTime || new Date(review.time * 1000).toLocaleDateString("en-GB")}
                  </span>
                </p>
                <p className="mt-0.5 text-sm break-words">{review.text}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
