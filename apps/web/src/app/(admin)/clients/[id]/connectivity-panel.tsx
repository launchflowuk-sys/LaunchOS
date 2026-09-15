import { clientConnectivity, type CheckOwner, type ConnectivityCheck, type SocialReality } from "@launchos/core";
import { listReachablePages, lookupInstagramForPage } from "@launchos/integrations";
import { Check, CircleDashed, Minus, TriangleAlert } from "lucide-react";
import { getDb } from "@/lib/db";

/**
 * Whether this client is actually plugged in, and what is left.
 *
 * Shoji's reason for it, in his words: *"when everything is green I know that
 * now it is my job — I can assign teams. When the infrastructure is not
 * complete I am demotivated."* Every fact here was already knowable, but only
 * by reading Graph by hand in a terminal, so the true state of a client was
 * invisible and everything felt half-done at once.
 *
 * **The Meta side is fetched on render rather than behind a button**, because
 * a panel you have to press to believe is a panel you stop pressing. Two Graph
 * reads, only when the client has a Page id recorded and Meta is configured,
 * so a client with nothing connected costs nothing. If it ever gets slow with
 * a hundred clients, the fix is caching the answer — not a button.
 *
 * A Graph failure degrades to "could not ask Meta", never to "not connected".
 * Telling Shoji to chase a client because our own token timed out is the one
 * wrong answer this panel must not give.
 */

const STATE_STYLE = {
  ok: { icon: Check, className: "bg-success-pill text-white", label: "Done" },
  missing: { icon: TriangleAlert, className: "bg-warning-solid text-white", label: "Needed" },
  blocked: { icon: CircleDashed, className: "bg-neutral-solid text-white", label: "Blocked" },
  not_applicable: { icon: Minus, className: "bg-muted text-muted-foreground", label: "N/A" },
} as const;

const OWNER_LABEL: Record<CheckOwner, string> = {
  owner: "You",
  client: "Them",
  platform: "Setup",
};

/**
 * Asks Meta what it can actually reach, for the one Page this client has.
 *
 * Returns `reachablePageIds: null` when Meta is not configured at all, which
 * the core grader turns into a `blocked` check owned by `platform` — Shoji's
 * credential problem, not the client's.
 */
async function socialReality(pageId: string | null): Promise<SocialReality | undefined> {
  if (!pageId) return undefined;
  try {
    const pages = await listReachablePages(process.env);
    const reachablePageIds = pages.map((page) => page.id);
    // Only ask about the Instagram of a Page the token can actually see: a
    // lookup on an unreachable Page fails with a permissions error that reads
    // like "no Instagram" and would send him chasing the wrong thing.
    const instagramByPageId: Record<string, string | null> = {};
    if (reachablePageIds.includes(pageId)) {
      const account = await lookupInstagramForPage(pageId, process.env);
      instagramByPageId[pageId] = account?.id ?? null;
    }
    return { reachablePageIds, instagramByPageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    // A missing credential and a refused call are different problems, and the
    // core grader words them differently, so the shape says which.
    if (/META_ADS_ACCESS_TOKEN/.test(message)) {
      return { reachablePageIds: null, instagramByPageId: {} };
    }
    return { reachablePageIds: [], instagramByPageId: {}, error: message };
  }
}

export async function ConnectivityPanel({
  organisationId,
  clientId,
  facebookPageId,
}: {
  organisationId: string;
  clientId: string;
  /** From the client's channel rows; null skips the Graph reads entirely. */
  facebookPageId: string | null;
}) {
  const social = await socialReality(facebookPageId);
  const state = await clientConnectivity(getDb(), organisationId, clientId, social);

  const outstanding = state.checks.filter((c) => c.state === "missing" || c.state === "blocked");
  const yours = outstanding.filter((c) => c.owner === "owner").length;
  const theirs = outstanding.filter((c) => c.owner === "client").length;

  return (
    <div className="grid gap-4">
      <div
        className={
          state.complete
            ? "rounded-[20px] border border-success-pill/40 bg-success-pill/10 p-5"
            : "rounded-[20px] border bg-card p-5"
        }
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-lg font-medium">
            {state.complete ? "Fully connected" : `${state.ready} of ${state.total} connected`}
          </p>
          <p className="text-meta text-muted-foreground">
            {state.packageName ?? "No plan set"}
          </p>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {state.complete
            ? "Everything this plan needs is in place. The infrastructure is not what is holding this client up."
            : [
                yours > 0 ? `${yours} on you` : null,
                theirs > 0 ? `${theirs} on them` : null,
              ]
                .filter(Boolean)
                .join(", ") + " — the rest is done."}
        </p>
      </div>

      <ul className="grid gap-0">
        {state.checks.map((item) => (
          <CheckRow key={item.key} check={item} />
        ))}
      </ul>

      {facebookPageId && social?.error ? (
        <p className="text-sm text-muted-foreground">
          Meta could not be reached on this load, so the Facebook and Instagram rows show what we last knew rather than
          what is true. Reload to try again.
        </p>
      ) : null}
    </div>
  );
}

function CheckRow({ check }: { check: ConnectivityCheck }) {
  const style = STATE_STYLE[check.state];
  const Icon = style.icon;
  const dimmed = check.state === "not_applicable";

  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-x-3 border-t py-3 last:border-b">
      <span aria-hidden className={`mt-0.5 grid size-6 place-items-center rounded-full ${style.className}`}>
        <Icon className="size-3.5" strokeWidth={3} />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className={dimmed ? "text-sm text-muted-foreground" : "text-sm font-medium"}>{check.label}</p>
          {check.state === "missing" || check.state === "blocked" ? (
            <span className="text-meta text-muted-foreground">{OWNER_LABEL[check.owner]}</span>
          ) : null}
          <span className="sr-only">{style.label}</span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{check.detail}</p>
        {/* The instruction, only where there is one. This is the line that
            turns a red row into a phone call somebody can actually make. */}
        {check.next ? <p className="mt-1 text-sm break-words text-foreground">{check.next}</p> : null}
      </div>
    </li>
  );
}
