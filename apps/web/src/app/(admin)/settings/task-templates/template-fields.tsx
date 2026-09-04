export const FIELD = "mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";
export const LABEL = "block text-xs font-medium text-neutral-500";

export type TemplateEnums = {
  phases: readonly string[];
  kinds: readonly string[];
  recurrences: readonly string[];
  assigneeRoles: readonly string[];
};

export type TemplateDefaults = {
  packageId: string;
  phase: string;
  kind: string;
  title: string;
  descriptionMd: string;
  offsetDays: number;
  recurrence: string;
  defaultAssigneeRole: string;
  sortOrder: number;
  checklist: readonly string[];
};

function Select({ name, label, value, options }: { name: string; label: string; value: string; options: readonly string[] }) {
  return (
    <label className={LABEL}>
      {label}
      <select name={name} defaultValue={value} className={FIELD}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The inputs shared by "New template" and every per-template edit form. A plain
 * server component: the surrounding `<form>` supplies the action.
 *
 * Reordering is editing `sortOrder` and saving — no drag-and-drop library, and
 * it works on a phone.
 */
export function TemplateFields({
  defaults,
  enums,
  packages,
  showPhase,
}: {
  defaults: TemplateDefaults;
  enums: TemplateEnums;
  packages: { value: string; label: string }[];
  showPhase: boolean;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Title
          <input name="title" required maxLength={200} defaultValue={defaults.title} className={FIELD} />
        </label>
        <label className={LABEL}>
          Package
          <select name="packageId" defaultValue={defaults.packageId} className={FIELD}>
            <option value="">Every package</option>
            {packages.map((pkg) => (
              <option key={pkg.value} value={pkg.value}>
                {pkg.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {showPhase ? (
          <Select name="phase" label="Phase" value={defaults.phase} options={enums.phases} />
        ) : (
          <input type="hidden" name="phase" value={defaults.phase} />
        )}
        <Select name="kind" label="Kind" value={defaults.kind} options={enums.kinds} />
        <Select name="recurrence" label="Recurrence" value={defaults.recurrence} options={enums.recurrences} />
        <Select
          name="defaultAssigneeRole"
          label="Default assignee"
          value={defaults.defaultAssigneeRole}
          options={enums.assigneeRoles}
        />
        <label className={LABEL}>
          Offset days
          <input type="number" name="offsetDays" min={0} max={365} defaultValue={defaults.offsetDays} className={FIELD} />
        </label>
        <label className={LABEL}>
          Sort order
          <input type="number" name="sortOrder" min={0} max={10000} defaultValue={defaults.sortOrder} className={FIELD} />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Description
          <textarea
            name="descriptionMd"
            rows={3}
            defaultValue={defaults.descriptionMd}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white p-2 text-sm text-neutral-900"
          />
        </label>
        <label className={LABEL}>
          Checklist (one item per line)
          <textarea
            name="checklist"
            rows={3}
            defaultValue={defaults.checklist.join("\n")}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white p-2 text-sm text-neutral-900"
          />
        </label>
      </div>
    </>
  );
}
