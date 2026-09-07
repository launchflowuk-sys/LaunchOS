import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { deliverProjectAction, updateProjectAction } from "../actions";
import { PROJECT_STATUS_LABEL, PROJECT_STATUSES } from "../schemas";

/**
 * The two forms on the detail page that are not the spine or the milestones.
 *
 * Both are plain server-action forms through `ActionForm` rather than
 * react-hook-form: neither has a field that needs validating as you type, and
 * a refusal from core — "that project was already delivered" — is a sentence
 * the toast shows, which is the only failure either can have.
 */

export function ProjectDetailsForm({
  projectId,
  defaults,
}: {
  projectId: string;
  defaults: { name: string; summary: string; status: string; targetDate: string };
}) {
  return (
    <ActionForm action={updateProjectAction} success="Project saved" ariaLabel="Project details" className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="space-y-1.5">
        <Label htmlFor="project-name">Project</Label>
        <Input id="project-name" name="name" required maxLength={300} defaultValue={defaults.name} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="project-status">Status</Label>
          <NativeSelect key={defaults.status} id="project-status" name="status" defaultValue={defaults.status}>
            {PROJECT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {PROJECT_STATUS_LABEL[status]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="project-target">Target date</Label>
          <Input id="project-target" name="targetDate" type="date" defaultValue={defaults.targetDate} />
        </div>
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="project-summary">Summary</Label>
        <Textarea id="project-summary" name="summary" rows={3} maxLength={4000} defaultValue={defaults.summary} />
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" variant="secondary" className="max-sm:w-full">
          Save project
        </Button>
      </div>
    </ActionForm>
  );
}

/**
 * Sign-off.
 *
 * This is the only thing that puts a client's page at 100%, so it is
 * deliberately a decision with a note rather than a switch on the details
 * form. Outstanding steps and milestones are left exactly as they are: the
 * honest record is "delivered, with two care milestones still open".
 */
export function DeliverProjectForm({ projectId, outstanding }: { projectId: string; outstanding: number }) {
  return (
    <ActionForm
      action={deliverProjectAction}
      success="Delivered — the case study is ready to be written"
      ariaLabel="Deliver this project"
      className="grid gap-3"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <div className="space-y-1.5">
        <Label htmlFor="deliver-note">What was handed over</Label>
        <Textarea
          id="deliver-note"
          name="note"
          rows={2}
          maxLength={2000}
          placeholder="Site live on the client's domain, dispatch office handed over, training done."
        />
        <p className="text-meta text-muted-foreground">
          Goes on the client&rsquo;s timeline. Their progress page reads 100% from this moment
          {outstanding > 0
            ? `, and the ${outstanding === 1 ? "one item" : `${outstanding} items`} still open stay on the timeline rather than being tidied away.`
            : "."}
        </p>
      </div>
      <div>
        <Button type="submit" variant="success" className="max-sm:w-full">
          Deliver this project
        </Button>
      </div>
    </ActionForm>
  );
}
