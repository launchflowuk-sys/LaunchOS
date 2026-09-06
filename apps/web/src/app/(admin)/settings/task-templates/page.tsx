import { listPackages, listTaskTemplates } from "@launchos/core";
import { schema } from "@launchos/db";
import { LayoutTemplate } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
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

const CARD = "space-y-4 rounded-xl border bg-card p-4 sm:p-5";

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
        category="organisation"
      />

      <Section title="New template">
        <ActionForm
          action={createTemplateAction}
          ariaLabel="New template"
          success="Template created"
          resetOnSuccess
          className={CARD}
        >
          <TemplateFields
            idPrefix="new-template"
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
              evidence: { required: false, kinds: [], checklist: [] },
            }}
            enums={ENUMS}
            packages={packageOptions}
            showPhase
          />
          <div className="flex justify-end max-sm:[&>*]:w-full">
            <Button type="submit">Create template</Button>
          </div>
        </ActionForm>
      </Section>

      {SECTIONS.map((section) => {
        const rows = templates.filter((template) => template.phase === section.phase);
        return (
          <Section key={section.phase} title={section.heading} description={section.hint}>
            {rows.length === 0 ? (
              <EmptyState icon={LayoutTemplate}>No {section.phase} templates yet.</EmptyState>
            ) : (
              <div className="space-y-4">
                {rows.map((template) => (
                  <div key={template.id} className={CARD}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-semibold">{template.title}</p>
                        <p className="mt-0.5 text-meta text-muted-foreground">
                          {template.packageId ? (nameById.get(template.packageId) ?? "Unknown package") : "Every package"}{" "}
                          · sort {template.sortOrder}
                        </p>
                      </div>
                      {/* In the header rather than under the form: a delete
                          button on its own row, once per template, turned this
                          screen into a column of red bars. */}
                      <ActionForm
                        action={deleteTemplateAction}
                        ariaLabel={`Delete template ${template.title}`}
                        success="Template deleted"
                        className="shrink-0"
                      >
                        <input type="hidden" name="templateId" value={template.id} />
                        <Button type="submit" variant="destructive-quiet" size="sm">
                          Delete
                        </Button>
                      </ActionForm>
                    </div>
                    <ActionForm
                      action={updateTemplateAction}
                      ariaLabel={`Template ${template.title}`}
                      success="Template saved"
                    >
                      <input type="hidden" name="templateId" value={template.id} />
                      {/* Folded away by default. Every template is a fourteen-
                          field form, and a dozen of them open at once made this
                          screen fourteen thousand pixels tall — unscannable on a
                          phone, which is where it is read. */}
                      <details className="space-y-4">
                        <summary className="cursor-pointer text-row text-muted-foreground hover:text-foreground">
                          Edit template
                        </summary>
                        <TemplateFields
                          idPrefix={`template-${template.id}`}
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
                            evidence: template.evidence,
                          }}
                          enums={ENUMS}
                          packages={packageOptions}
                          showPhase={false}
                        />
                        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
                          <Button type="submit" variant="secondary">
                            Save
                          </Button>
                        </div>
                      </details>
                    </ActionForm>
                  </div>
                ))}
              </div>
            )}
          </Section>
        );
      })}
    </>
  );
}
