import { listPackages, listTaskTemplates } from "@launchos/core";
import { schema } from "@launchos/db";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { createTemplateAction, deleteTemplateAction, updateTemplateAction } from "./actions";
import { type TemplateEnums, TemplateFields } from "./template-fields";

export const dynamic = "force-dynamic";

// Read here, in a server component, and handed down as plain arrays: the field
// block is shared with client-side forms and must not reach @launchos/db.
const ENUMS: TemplateEnums = {
  phases: schema.taskPhaseEnum.enumValues,
  kinds: schema.taskKindEnum.enumValues,
  recurrences: schema.taskRecurrenceEnum.enumValues,
  assigneeRoles: schema.taskAssigneeRoleEnum.enumValues,
};

const SECTIONS = [
  { phase: "onboarding", heading: "Onboarding", hint: "Due date is the client's start date plus the offset." },
  { phase: "recurring", heading: "Recurring", hint: "Quantity comes from the package's monthly includes." },
  { phase: "support", heading: "Support", hint: "Blueprints for repeatable support work." },
] as const;

const CARD = "space-y-3 rounded-lg border border-neutral-200 bg-white p-4";

export default async function TaskTemplatesPage() {
  const session = await requireAdmin();
  const [templates, packages] = await Promise.all([
    listTaskTemplates(getDb(), session.organisationId, {}),
    listPackages(getDb(), session.organisationId, {}),
  ]);

  const packageOptions = packages.map((pkg) => ({ value: pkg.id, label: pkg.name }));
  const nameById = new Map(packages.map((pkg) => [pkg.id, pkg.name]));

  return (
    <>
      <PageHeader
        title="Task templates"
        description="The blueprints onboarding and recurring generation turn into tasks. Reorder by editing sort order."
      />

      <div className="space-y-8">
        <section>
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">New template</h2>
          <ActionForm
            action={createTemplateAction}
            ariaLabel="New template"
            success="Template created"
            resetOnSuccess
            className={CARD}
          >
            <TemplateFields
              defaults={{
                packageId: "",
                phase: "onboarding",
                kind: "other",
                title: "",
                descriptionMd: "",
                offsetDays: 0,
                recurrence: "none",
                defaultAssigneeRole: "any",
                sortOrder: 0,
                checklist: [],
              }}
              enums={ENUMS}
              packages={packageOptions}
              showPhase
            />
            <div className="flex justify-end">
              <Button type="submit">Create template</Button>
            </div>
          </ActionForm>
        </section>

        {SECTIONS.map((section) => {
          const rows = templates.filter((template) => template.phase === section.phase);
          return (
            <section key={section.phase} className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">{section.heading}</h2>
                <p className="text-xs text-neutral-500">{section.hint}</p>
              </div>
              {rows.length === 0 ? (
                <EmptyState>No {section.phase} templates yet.</EmptyState>
              ) : (
                rows.map((template) => (
                  <div key={template.id} className={CARD}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-neutral-900">{template.title}</p>
                      <p className="text-xs text-neutral-400">
                        {template.packageId ? (nameById.get(template.packageId) ?? "Unknown package") : "Every package"}{" "}
                        · sort {template.sortOrder}
                      </p>
                    </div>
                    <ActionForm
                      action={updateTemplateAction}
                      ariaLabel={`Template ${template.title}`}
                      success="Template saved"
                      className="space-y-3"
                    >
                      <input type="hidden" name="templateId" value={template.id} />
                      <TemplateFields
                        defaults={{
                          packageId: template.packageId ?? "",
                          phase: template.phase,
                          kind: template.kind,
                          title: template.title,
                          descriptionMd: template.descriptionMd ?? "",
                          offsetDays: template.offsetDays,
                          recurrence: template.recurrence,
                          defaultAssigneeRole: template.defaultAssigneeRole,
                          sortOrder: template.sortOrder,
                          checklist: template.checklist,
                        }}
                        enums={ENUMS}
                        packages={packageOptions}
                        showPhase={false}
                      />
                      <div className="flex justify-end">
                        <Button type="submit" variant="secondary">
                          Save
                        </Button>
                      </div>
                    </ActionForm>
                    <ActionForm
                      action={deleteTemplateAction}
                      ariaLabel={`Delete template ${template.title}`}
                      success="Template deleted"
                      className="flex justify-end"
                    >
                      <input type="hidden" name="templateId" value={template.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </ActionForm>
                  </div>
                ))
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
