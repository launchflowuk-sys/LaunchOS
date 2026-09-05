import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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

function EnumSelect({
  id, name, label, value, options,
}: { id: string; name: string; label: string; value: string; options: readonly string[] }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} name={name} defaultValue={value}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll("_", " ")}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/**
 * The inputs shared by "New template" and every per-template edit form. A plain
 * server component: the surrounding `<form>` supplies the action.
 *
 * Reordering is editing `sortOrder` and saving — no drag-and-drop library, and
 * it works on a phone.
 *
 * `idPrefix` is what keeps `htmlFor` honest: this block is rendered once per
 * template on the same screen and a server component has no `useId`, so the
 * caller passes the template id (or "new") and every control keeps a unique id.
 */
export function TemplateFields({
  defaults,
  enums,
  packages,
  showPhase,
  idPrefix,
}: {
  defaults: TemplateDefaults;
  enums: TemplateEnums;
  packages: { value: string; label: string }[];
  showPhase: boolean;
  idPrefix: string;
}) {
  const id = (field: string) => `${idPrefix}-${field}`;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={id("title")}>Title</Label>
          <Input id={id("title")} name="title" required maxLength={200} defaultValue={defaults.title} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("packageId")}>Package</Label>
          <NativeSelect id={id("packageId")} name="packageId" defaultValue={defaults.packageId}>
            <option value="">Every package</option>
            {packages.map((pkg) => (
              <option key={pkg.value} value={pkg.value}>
                {pkg.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {showPhase ? (
          <EnumSelect id={id("phase")} name="phase" label="Phase" value={defaults.phase} options={enums.phases} />
        ) : (
          <input type="hidden" name="phase" value={defaults.phase} />
        )}
        <EnumSelect id={id("kind")} name="kind" label="Kind" value={defaults.kind} options={enums.kinds} />
        <EnumSelect
          id={id("recurrence")}
          name="recurrence"
          label="Recurrence"
          value={defaults.recurrence}
          options={enums.recurrences}
        />
        <EnumSelect
          id={id("defaultAssigneeRole")}
          name="defaultAssigneeRole"
          label="Default assignee"
          value={defaults.defaultAssigneeRole}
          options={enums.assigneeRoles}
        />
        <div className="space-y-1.5">
          <Label htmlFor={id("offsetDays")}>Offset days</Label>
          <Input
            id={id("offsetDays")}
            type="number"
            name="offsetDays"
            min={0}
            max={365}
            defaultValue={defaults.offsetDays}
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("sortOrder")}>Sort order</Label>
          <Input
            id={id("sortOrder")}
            type="number"
            name="sortOrder"
            min={0}
            max={10000}
            defaultValue={defaults.sortOrder}
            className="tabular-nums"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={id("descriptionMd")}>Description</Label>
          <Textarea id={id("descriptionMd")} name="descriptionMd" rows={3} defaultValue={defaults.descriptionMd} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("checklist")}>Checklist (one item per line)</Label>
          <Textarea id={id("checklist")} name="checklist" rows={3} defaultValue={defaults.checklist.join("\n")} />
        </div>
      </div>
    </>
  );
}
