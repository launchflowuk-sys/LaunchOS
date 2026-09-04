import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";

type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

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
}) {
  return (
    <ActionForm
      action={action}
      ariaLabel={label}
      success={success}
      resetOnSuccess
      className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4"
    >
      {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label className="block text-sm font-medium text-neutral-700">
        {label}
        <textarea
          name="body"
          rows={4}
          required
          maxLength={8000}
          placeholder={placeholder}
          className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm font-normal text-neutral-900"
        />
      </label>
      <Button type="submit">{submitLabel}</Button>
    </ActionForm>
  );
}
