import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";

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
 * notes the client never sees. Inbound sits on white, our outbound mail on
 * blue, an internal note on amber with an explicit label so nobody mistakes a
 * note for something the client read.
 */
function toneFor(message: AdminThreadMessage): string {
  if (message.direction === "internal") return "border-amber-200 bg-amber-50";
  if (message.direction === "outbound") return "border-blue-100 bg-blue-50";
  return "border-neutral-200 bg-white";
}

export function MessageThread({ messages }: { messages: readonly AdminThreadMessage[] }) {
  if (messages.length === 0) {
    return <p className="text-sm text-neutral-400">Nothing on this thread yet.</p>;
  }

  return (
    <ol className="space-y-3">
      {messages.map((message) => (
        <li key={message.id} className={`rounded-lg border px-4 py-3 ${toneFor(message)}`}>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-neutral-700">{AUTHOR_LABEL[message.authorKind]}</span>
            {message.direction === "internal" ? (
              <span className="rounded border border-amber-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800">
                Internal note
              </span>
            ) : null}
            {message.status ? <StatusBadge value={message.status} /> : null}
            <span className="ml-auto text-neutral-500">{formatDateTime(message.createdAt)}</span>
          </div>
          {message.subject ? <p className="mb-1 text-xs text-neutral-500">{message.subject}</p> : null}
          {/* Plain text, never dangerouslySetInnerHTML: this body arrived by email. */}
          <p className="whitespace-pre-wrap text-sm text-neutral-800">{message.body}</p>
          {message.attachments.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {message.attachments.map((attachment) => (
                <li key={attachment.url}>
                  <a
                    href={attachment.url}
                    className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 underline"
                  >
                    {attachment.name} ({Math.round(attachment.size / 1024)} kB)
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
