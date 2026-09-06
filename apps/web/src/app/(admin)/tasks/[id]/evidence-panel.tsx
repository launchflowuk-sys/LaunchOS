import type { TaskEvidence, TaskTemplateEvidence } from "@launchos/db/schema";
import { Check, Image as ImageIcon, Link2, Trash2 } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import { addEvidenceLinkAction, removeEvidenceAction, tickEvidenceAction } from "../actions";
import { MAX_SCREENSHOT_BYTES, SCREENSHOT_MIMES } from "../schemas";
import { ScreenshotUpload } from "./screenshot-upload";

const KIND_LABEL: Record<TaskTemplateEvidence["kinds"][number], string> = {
  link: "a link to the delivered work",
  screenshot: "a screenshot",
  checklist: "every proof item ticked",
};

/** "a link to the delivered work, a screenshot and every proof item ticked" */
function ruleSentence(rule: TaskTemplateEvidence): string {
  const parts = rule.kinds.map((kind) => KIND_LABEL[kind]);
  if (parts.length === 0) return "nothing in particular";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The tick box the task's own checklist uses, so proof reads the same way. */
function TickBox({ done, label }: { done: boolean; label: string }) {
  return (
    <button
      type="submit"
      aria-label={done ? `Untick ${label}` : `Tick ${label}`}
      className={
        done
          ? "flex size-5 shrink-0 items-center justify-center rounded-[4px] border border-primary bg-primary text-primary-foreground transition-colors"
          : "flex size-5 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors hover:bg-muted"
      }
    >
      {done ? <Check aria-hidden strokeWidth={2.5} className="size-3.5" /> : null}
    </button>
  );
}

/**
 * Proof of work on the task page: the template's rule, the proof checklist,
 * the links and the screenshots — and what is still missing before Done.
 *
 * A server component: every write goes through an `ActionForm`, and the
 * upload through its own small client component. `memberNames` turns the
 * `doneBy` user id on a tick into a name.
 */
export function EvidencePanel({
  taskId,
  evidence,
  rule,
  satisfied,
  missing,
  memberNames,
  editable,
}: {
  taskId: string;
  evidence: TaskEvidence;
  rule: TaskTemplateEvidence;
  satisfied: boolean;
  missing: readonly string[];
  memberNames: ReadonlyMap<string, string>;
  /** False once the task is done or cancelled: the record stays, the forms go. */
  editable: boolean;
}) {
  const nothingToShow =
    !rule.required && evidence.checklist.length === 0 && evidence.links.length === 0 && evidence.attachments.length === 0;

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4">
      {rule.required ? (
        satisfied ? (
          <InlineAlert tone="success" title="Proof is complete">
            This task can be marked done.
          </InlineAlert>
        ) : (
          <InlineAlert tone="warning" title="Proof needed before this task can be marked done">
            The template asks for {ruleSentence(rule)}. Still needed: {missing.join("; ")}.
          </InlineAlert>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          {nothingToShow
            ? "No proof is required for this task. Anything added here is shown to the client on their Progress page."
            : "Proof is optional on this task; what is here is shown to the client on their Progress page."}
        </p>
      )}

      {evidence.checklist.length > 0 ? (
        <div>
          <p className="label-caps text-muted-foreground">Proof checklist</p>
          <ul className="mt-2 grid gap-2">
            {evidence.checklist.map((item, index) => {
              const by = item.doneBy ? (memberNames.get(item.doneBy) ?? "a member") : null;
              return (
                <li key={`${index}-${item.item}`} className="flex items-start gap-3">
                  {editable ? (
                    <ActionForm action={tickEvidenceAction} className="flex pt-0.5">
                      <input type="hidden" name="taskId" value={taskId} />
                      <input type="hidden" name="index" value={index} />
                      <input type="hidden" name="done" value={item.done ? "false" : "true"} />
                      <TickBox done={item.done} label={item.item} />
                    </ActionForm>
                  ) : (
                    <span className="pt-0.5">
                      <span
                        aria-label={item.done ? "Ticked" : "Not ticked"}
                        className={
                          item.done
                            ? "flex size-5 items-center justify-center rounded-[4px] border border-primary bg-primary text-primary-foreground"
                            : "flex size-5 items-center justify-center rounded-[4px] border border-input"
                        }
                      >
                        {item.done ? <Check aria-hidden strokeWidth={2.5} className="size-3.5" /> : null}
                      </span>
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className={item.done ? "text-sm text-muted-foreground line-through" : "text-sm"}>{item.item}</span>
                    {item.done && item.doneAt ? (
                      <span className="block text-meta text-muted-foreground">
                        {by ? `${by} · ` : ""}
                        {formatDateTime(item.doneAt)}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="label-caps text-muted-foreground">Links</p>
        {evidence.links.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No links yet.</p>
        ) : (
          <ul className="mt-2 divide-y rounded-lg border">
            {evidence.links.map((url) => (
              <li key={url} className="flex items-center gap-2 px-3 py-2 text-row">
                <Link2 aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
                <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-primary underline underline-offset-2">
                  {url}
                </a>
                {editable ? (
                  <ActionForm action={removeEvidenceAction} success="Link removed" className="shrink-0">
                    <input type="hidden" name="taskId" value={taskId} />
                    <input type="hidden" name="url" value={url} />
                    <Button type="submit" variant="ghost" size="icon" aria-label={`Remove link ${url}`}>
                      <Trash2 aria-hidden strokeWidth={1.75} />
                    </Button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {editable ? (
          <ActionForm
            action={addEvidenceLinkAction}
            ariaLabel="Add link"
            success="Link added"
            resetOnSuccess
            className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
          >
            <input type="hidden" name="taskId" value={taskId} />
            <div className="space-y-1.5">
              <Label htmlFor={`evidence-link-${taskId}`}>Link to the delivered work</Label>
              <Input
                id={`evidence-link-${taskId}`}
                name="url"
                type="url"
                inputMode="url"
                required
                maxLength={2000}
                placeholder="https://"
              />
            </div>
            <Button type="submit" variant="secondary" className="max-sm:w-full">
              Add link
            </Button>
          </ActionForm>
        ) : null}
      </div>

      <div>
        <p className="label-caps text-muted-foreground">Screenshots</p>
        {evidence.attachments.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No screenshots yet.</p>
        ) : (
          <ul className="mt-2 divide-y rounded-lg border">
            {evidence.attachments.map((attachment) => (
              <li key={attachment.id} className="flex items-center gap-2 px-3 py-2 text-row">
                <ImageIcon aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
                <a href={attachment.url} className="min-w-0 flex-1 truncate text-primary underline underline-offset-2">
                  {attachment.name}
                </a>
                <span className="shrink-0 text-meta text-muted-foreground">
                  {attachment.uploadedBy ? `${memberNames.get(attachment.uploadedBy) ?? "a member"} · ` : ""}
                  {formatDateTime(attachment.uploadedAt)}
                </span>
                {editable ? (
                  <ActionForm action={removeEvidenceAction} success="Screenshot removed" className="shrink-0">
                    <input type="hidden" name="taskId" value={taskId} />
                    <input type="hidden" name="attachmentId" value={attachment.id} />
                    <Button type="submit" variant="ghost" size="icon" aria-label={`Remove screenshot ${attachment.name}`}>
                      <Trash2 aria-hidden strokeWidth={1.75} />
                    </Button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {editable ? (
          <div className="mt-3">
            <ScreenshotUpload taskId={taskId} maxBytes={MAX_SCREENSHOT_BYTES} accept={SCREENSHOT_MIMES.join(",")} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
