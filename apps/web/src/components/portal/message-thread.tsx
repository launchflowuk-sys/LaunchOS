import { formatDateTime } from "@/lib/format";

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
 * The client-facing view of a conversation. Presentational and server-safe:
 * the caller does the filtering with `isVisibleToClient` so a page can never
 * render this component over an unfiltered list by accident.
 */
export function MessageThread({ messages }: { messages: readonly ThreadMessage[] }) {
  if (messages.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing on this thread yet.</p>;
  }

  return (
    <ol className="space-y-3">
      {messages.map((message) => {
        const fromClient = message.authorKind === "client";
        return (
          <li
            key={message.id}
            className={`rounded-lg border px-4 py-3 ${
              fromClient ? "border-neutral-200 bg-white" : "border-blue-100 bg-blue-50/60"
            }`}
          >
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-neutral-700">{AUTHOR_LABEL[message.authorKind]}</span>
              <span className="text-neutral-500">{formatDateTime(message.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-neutral-800">{message.body}</p>
          </li>
        );
      })}
    </ol>
  );
}
