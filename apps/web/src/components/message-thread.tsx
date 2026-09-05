import { Paperclip } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ThreadAttachment = { name: string; contentType: string; size: number; url: string };

export type AdminThreadMessage = {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  authorKind: "user" | "client" | "agent" | "system";
  authorId: string | null;
  body: string;
  subject: string | null;
  status: "queued" | "sent" | "failed" | "received" | null;
  createdAt: Date;
  attachments: readonly ThreadAttachment[];
};

const AUTHOR_LABEL: Record<AdminThreadMessage["authorKind"], string> = {
  client: "Client",
  user: "Staff",
  agent: "Agent",
  system: "System",
};

/**
 * The staff-side view of a conversation: every message, including the internal
 * notes the client never sees. Inbound sits on the card surface, our outbound
 * mail on the info trio, an internal note on the warning trio with an explicit
 * label so nobody mistakes a note for something the client read.
 *
 * The bubbles also lean: what came in sits left, what we sent sits right, so a
 * thread reads as a conversation at a glance rather than as a log.
 */
const TONE: Record<AdminThreadMessage["direction"], string> = {
  inbound: "border-border bg-card",
  outbound: "border-info-border bg-info-bg",
  internal: "border-warning-border bg-warning-bg",
};

export function MessageThread({ messages }: { messages: readonly AdminThreadMessage[] }) {
  if (messages.length === 0) {
    return (
      <p className="rounded-xl border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
        Nothing on this thread yet.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-3">
      {messages.map((message) => (
        <li
          key={message.id}
          className={cn(
            "min-w-0 rounded-xl border px-4 py-3 sm:max-w-[46rem]",
            TONE[message.direction],
            message.direction === "inbound" ? "sm:mr-auto" : "sm:ml-auto",
          )}
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-meta">
            <span className="font-semibold text-foreground">{AUTHOR_LABEL[message.authorKind]}</span>
            {message.direction === "internal" ? (
              <span className="label-caps rounded-full border border-warning-border px-2 py-0.5 text-warning-fg">
                Internal note
              </span>
            ) : null}
            {message.status ? <StatusBadge value={message.status} /> : null}
            <span className="ml-auto text-muted-foreground">{formatDateTime(message.createdAt)}</span>
          </div>
          {message.subject ? <p className="mb-1 text-meta text-muted-foreground">{message.subject}</p> : null}
          {/* Plain text, never dangerouslySetInnerHTML: this body arrived by email. */}
          <p className="text-sm break-words whitespace-pre-wrap text-foreground">{message.body}</p>
          {message.attachments.length > 0 ? (
            <ul className="mt-2.5 flex flex-wrap gap-2">
              {message.attachments.map((attachment) => (
                <li key={attachment.url}>
                  <a
                    href={attachment.url}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-meta text-foreground transition-colors hover:bg-muted"
                  >
                    <Paperclip aria-hidden strokeWidth={1.75} className="size-3.5 text-muted-foreground" />
                    <span className="break-all">{attachment.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {Math.round(attachment.size / 1024)} kB
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
