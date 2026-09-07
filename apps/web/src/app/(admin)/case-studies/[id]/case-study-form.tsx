import type { CaseStudyRow } from "@launchos/core";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { updateCaseStudyAction } from "../actions";
import {
  CASE_STUDY_DELIVERY_STATUSES,
  CASE_STUDY_KINDS,
  CASE_STUDY_STATUS_LABEL,
  CASE_STUDY_STATUSES,
  DELIVERY_STATUS_LABEL,
  KIND_LABEL,
} from "../schemas";

/**
 * Every field of a story, on one form.
 *
 * One form and one save rather than a section per field: this is the best copy
 * on the site and it is edited as a piece — the problem paragraph and the
 * results paragraph are written in the same sitting — so five separate saves
 * would only make it possible to publish half a rewrite.
 *
 * The product-only fields are on the same form rather than behind the kind
 * picker, because hiding them would mean a client build that becomes a product
 * silently loses its tagline. They are grouped and labelled instead.
 */

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Group({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <fieldset className="border-t pt-5 first:border-t-0 first:pt-0">
      <legend className="sr-only">{title}</legend>
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-0.5 mb-4 text-sm text-muted-foreground">{description}</p>
      {children}
    </fieldset>
  );
}

export function CaseStudyForm({ study }: { study: CaseStudyRow }) {
  return (
    <ActionForm action={updateCaseStudyAction} success="Story saved" ariaLabel="Case study" className="grid gap-6">
      <input type="hidden" name="caseStudyId" value={study.id} />

      <Group title="The card" description="What the Work index shows: the name, the one line, and the labels on it.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="cs-name" label="Name">
            <Input id="cs-name" name="name" required maxLength={300} defaultValue={study.name} />
          </Field>
          <Field id="cs-slug" label="Web address" hint="The public URL is /work/<this>. Changing it breaks any link already shared.">
            <Input id="cs-slug" name="slug" required maxLength={120} defaultValue={study.slug} />
          </Field>
          <Field id="cs-client-name" label="Who it was for" hint='The short name beside the title — "Chathwell Windows Ltd" under "LifeStyle Windows".'>
            <Input id="cs-client-name" name="clientName" maxLength={300} defaultValue={study.clientName ?? ""} />
          </Field>
          <Field id="cs-sector" label="Sector" hint="The small label above the name. For a product, its market.">
            <Input id="cs-sector" name="sector" maxLength={200} defaultValue={study.sector} />
          </Field>
          <div className="sm:col-span-2">
            <Field id="cs-summary" label="One line" hint="One sentence on the card, and the one the home page grid prints.">
              <Textarea id="cs-summary" name="summary" rows={2} maxLength={1000} defaultValue={study.summary} />
            </Field>
          </div>
          <Field id="cs-year" label="Year">
            <Input id="cs-year" name="year" type="number" min={1990} max={2200} defaultValue={study.year ?? ""} />
          </Field>
          <Field id="cs-url" label="Live address">
            <Input id="cs-url" name="url" maxLength={500} defaultValue={study.url ?? ""} placeholder="https://example.co.uk" />
          </Field>
        </div>
      </Group>

      <Group title="The brief" description="The four questions the page reads in order. Do not lose a word of what is already written.">
        <div className="grid gap-3">
          <Field id="cs-brief-client" label="The client">
            <Textarea id="cs-brief-client" name="briefClient" rows={3} maxLength={4000} defaultValue={study.brief.client} />
          </Field>
          <Field id="cs-brief-problem" label="The problem">
            <Textarea id="cs-brief-problem" name="briefProblem" rows={3} maxLength={4000} defaultValue={study.brief.problem} />
          </Field>
          <Field id="cs-brief-built" label="What we built">
            <Textarea id="cs-brief-built" name="briefBuilt" rows={5} maxLength={8000} defaultValue={study.brief.built} />
          </Field>
          <Field id="cs-brief-results" label="Results">
            <Textarea id="cs-brief-results" name="briefResults" rows={3} maxLength={4000} defaultValue={study.brief.results} />
          </Field>
        </div>
      </Group>

      <Group title="Where it stands" description="Publication and delivery are two different facts, so they are two different fields.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="cs-status" label="Publication">
            <NativeSelect key={study.status} id="cs-status" name="status" defaultValue={study.status}>
              {CASE_STUDY_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {CASE_STUDY_STATUS_LABEL[option]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="cs-delivery" label="The build">
            <NativeSelect key={study.deliveryStatus} id="cs-delivery" name="deliveryStatus" defaultValue={study.deliveryStatus}>
              {CASE_STUDY_DELIVERY_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {DELIVERY_STATUS_LABEL[option]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="cs-kind" label="Kind">
            <NativeSelect key={study.kind} id="cs-kind" name="kind" defaultValue={study.kind}>
              {CASE_STUDY_KINDS.map((option) => (
                <option key={option} value={option}>
                  {KIND_LABEL[option]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex flex-col justify-center gap-2 pt-5">
            <Label htmlFor="cs-featured" className="gap-2">
              <input id="cs-featured" name="featured" type="checkbox" defaultChecked={study.featured} className="size-4 rounded-[4px] border border-input accent-primary" />
              On the home page
            </Label>
            <Label htmlFor="cs-charity" className="gap-2">
              <input id="cs-charity" name="charity" type="checkbox" defaultChecked={study.charity} className="size-4 rounded-[4px] border border-input accent-primary" />
              Built free, as charity
            </Label>
          </div>
        </div>
      </Group>

      <Group title="Screenshots" description="Paths under /public. The capture script writes these; a blank one shows a named placeholder rather than a broken image.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="cs-shot-desktop" label="Desktop">
            <Input id="cs-shot-desktop" name="screenshotDesktop" maxLength={500} defaultValue={study.screenshots.desktop ?? ""} placeholder={`/work/${study.slug}-desktop.jpg`} />
          </Field>
          <Field id="cs-shot-mobile" label="Phone">
            <Input id="cs-shot-mobile" name="screenshotMobile" maxLength={500} defaultValue={study.screenshots.mobile ?? ""} placeholder={`/work/${study.slug}-mobile.jpg`} />
          </Field>
        </div>
      </Group>

      <Group title="The stack" description="One per line. They render as chips beside the brief.">
        <Field id="cs-stack" label="Technology">
          <Textarea id="cs-stack" name="stack" rows={4} defaultValue={study.stack.join("\n")} placeholder={"React\nPostgreSQL\nCoolify"} />
        </Field>
      </Group>

      <Group
        title="Runs on one of ours"
        description="The platform badge — all three fields or none, because a name with no logo renders an empty image."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="cs-pb-name" label="Platform">
            <Input id="cs-pb-name" name="poweredByName" maxLength={120} defaultValue={study.poweredBy?.name ?? ""} placeholder="Cabio" />
          </Field>
          <Field id="cs-pb-url" label="Platform address">
            <Input id="cs-pb-url" name="poweredByUrl" maxLength={500} defaultValue={study.poweredBy?.url ?? ""} placeholder="https://cabio.cab" />
          </Field>
          <Field id="cs-pb-logo" label="Logo path">
            <Input id="cs-pb-logo" name="poweredByLogo" maxLength={500} defaultValue={study.poweredBy?.logo ?? ""} placeholder="/brand/cabio-logo.png" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="cs-pb-w" label="Width">
              <Input id="cs-pb-w" name="poweredByWidth" type="number" min={1} defaultValue={study.poweredBy?.logoWidth ?? ""} />
            </Field>
            <Field id="cs-pb-h" label="Height">
              <Input id="cs-pb-h" name="poweredByHeight" type="number" min={1} defaultValue={study.poweredBy?.logoHeight ?? ""} />
            </Field>
          </div>
        </div>
      </Group>

      <Group title="If it is one of our products" description="The Products page reads these. A client build leaves them blank.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="cs-domain" label="Domain shown">
            <Input id="cs-domain" name="domain" maxLength={300} defaultValue={study.domain ?? ""} placeholder="cabio.cab" />
          </Field>
          <Field id="cs-tagline" label="Tagline">
            <Input id="cs-tagline" name="tagline" maxLength={500} defaultValue={study.tagline ?? ""} />
          </Field>
          <div className="sm:col-span-2">
            <Field id="cs-description" label="Description" hint="The paragraph on the Products page, longer than the one line above.">
              <Textarea id="cs-description" name="description" rows={4} maxLength={8000} defaultValue={study.description ?? ""} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field id="cs-facts" label="Facts" hint="Two to four short facts, one per line.">
              <Textarea id="cs-facts" name="facts" rows={4} defaultValue={study.facts.join("\n")} />
            </Field>
          </div>
        </div>
      </Group>

      <div>
        <Button type="submit" className="max-sm:w-full">
          Save story
        </Button>
      </div>
    </ActionForm>
  );
}
