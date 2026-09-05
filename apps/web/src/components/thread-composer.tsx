import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/** A stable id from the composer's own label: two composers on one thread never collide. */
function fieldId(label: string): string {
  return `composer-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
}

/**
 * The reply / internal-note box under a conversation thread. A server
 * component that hands the server action down to `ActionForm`, so the failure
 * message arrives as a toast rather than Next's error page and no
 * `@launchos/core` import reaches the browser bundle.
 */
export function ThreadComposer({
  action,
  conversationId,
  label,
  submitLabel,
  placeholder,
  success,
  hidden,
  submitVariant = "primary",
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  /**
   * Omitted when the action derives the thread itself — the case screen posts
   * only the ticket id, and the conversation is read off that row.
   */
  conversationId?: string;
  label: string;
  submitLabel: string;
  placeholder?: string;
  success: string;
  /** Extra hidden fields the action needs, e.g. the case this thread belongs to. */
  hidden?: Readonly<Record<string, string>>;
  /** Only one composer on a screen is the main action; the rest are secondary. */
  submitVariant?: "primary" | "secondary";
}) {
  const id = fieldId(label);

  return (
    <ActionForm
      action={action}
      ariaLabel={label}
      success={success}
      resetOnSuccess
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} name="body" rows={4} required maxLength={8000} placeholder={placeholder} />
      <Button type="submit" variant={submitVariant} className="max-sm:w-full">
        {submitLabel}
      </Button>
    </ActionForm>
  );
}
