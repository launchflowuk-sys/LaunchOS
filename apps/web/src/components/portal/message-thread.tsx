import { MessagesSquare } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ThreadMessage = {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  authorKind: "user" | "client" | "agent" | "system";
  body: string;
  createdAt: Date;
};

/**
 * Whether a message may be shown to the client who owns the thread.
 *
 * One clause, and it has to stay one clause: `internal` means "written by us,
 * about them" and must never render here, whoever the author says they were.
 * The client's own words — the opening body of a portal-raised ticket, every
 * reply, every inbound email — are written `inbound` by `createTicket` and
 * `replyAsClient`, so nothing of theirs is hidden by it.
 */
export function isVisibleToClient(message: Pick<ThreadMessage, "direction">): boolean {
  return message.direction !== "internal";
}

const AUTHOR_LABEL: Record<ThreadMessage["authorKind"], string> = {
  client: "You",
  user: "LaunchFlow",
  agent: "LaunchFlow",
  system: "LaunchFlow",
};

/**
 * The client-facing view of a conversation, as a thread of bubbles.
 *
 * Presentational and server-safe: the caller does the filtering with
 * `isVisibleToClient` so a page can never render this component over an
 * unfiltered list by accident.
 *
 * Direction carries the colour. The client's own messages sit right on the
 * indigo `primary-soft`, ours sit left on white — the arrangement every
 * messaging app has taught them, so nobody has to read "You" to know who said
 * what. The bubble caps at `85%` rather than a fixed width so a one-word reply
 * is a one-word bubble on a 375px phone.
 */
export function MessageThread({ messages }: { messages: readonly ThreadMessage[] }) {
  if (messages.length === 0) {
    return (
      <EmptyState icon={MessagesSquare}>
        Nothing on this thread yet. Add a reply below and we will pick it up.
      </EmptyState>
    );
  }

  return (
    <ol className="flex flex-col gap-4">
      {messages.map((message) => {
        const fromClient = message.authorKind === "client";
        return (
          <li key={message.id} className={cn("flex min-w-0", fromClient ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "min-w-0 max-w-[85%] rounded-xl border px-4 py-3",
                fromClient ? "border-primary/20 bg-primary-soft" : "border-border bg-card",
              )}
            >
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-meta font-semibold">{AUTHOR_LABEL[message.authorKind]}</span>
                <span className="text-meta text-muted-foreground">{formatDateTime(message.createdAt)}</span>
              </div>
              <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{message.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
