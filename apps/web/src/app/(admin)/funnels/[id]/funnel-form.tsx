import type { FunnelRow } from "@launchos/core";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { updateFunnelAction } from "../actions";

/** Everything about a funnel that is not a question, on one form and one save. */
export function FunnelForm({
  funnel,
  clients,
  bestScore,
}: {
  funnel: FunnelRow;
  clients: readonly { id: string; name: string }[];
  bestScore: number;
}) {
  return (
    <ActionForm action={updateFunnelAction} success="Funnel saved" ariaLabel="Funnel settings" className="grid gap-5 rounded-xl border bg-card p-5">
      <input type="hidden" name="funnelId" value={funnel.id} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required maxLength={160} defaultValue={funnel.name} />
          <p className="text-meta text-muted-foreground">Ours, not the visitor&apos;s. It appears on the lead so you know which advert it came from.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="slug">Web address</Label>
          <Input id="slug" name="slug" required maxLength={60} defaultValue={funnel.slug} className="font-mono" />
          <p className="text-meta text-muted-foreground">The page is /f/{funnel.slug} on both hosts.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="clientId">Client</Label>
          <NativeSelect id="clientId" name="clientId" defaultValue={funnel.clientId ?? ""}>
            <option value="">Ours (no client)</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hotScore">Ring me at this score</Label>
          <Input id="hotScore" name="hotScore" type="number" min={0} max={1000} defaultValue={funnel.hotScore} className="tabular-nums" />
          <p className="text-meta text-muted-foreground">
            The best this funnel can score is {bestScore}. A visitor at or above the threshold buzzes your phone the moment they leave a
            number. Zero switches the alert off.
          </p>
        </div>
      </div>

      <fieldset className="grid gap-4 border-t pt-5">
        <legend className="text-base font-semibold">The first screen</legend>
        <div className="space-y-1.5">
          <Label htmlFor="headline">Headline</Label>
          <Input id="headline" name="headline" maxLength={200} defaultValue={funnel.headline} placeholder={funnel.name} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="subheadline">Line underneath</Label>
          <Input id="subheadline" name="subheadline" maxLength={400} defaultValue={funnel.subheadline} />
        </div>
      </fieldset>

      <fieldset className="grid gap-4 border-t pt-5">
        <legend className="text-base font-semibold">The thank-you screen</legend>
        <div className="space-y-1.5">
          <Label htmlFor="successHeadline">Heading</Label>
          <Input id="successHeadline" name="successHeadline" required maxLength={160} defaultValue={funnel.success.headline} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="successBody">Paragraph</Label>
          <Textarea id="successBody" name="successBody" rows={3} maxLength={600} defaultValue={funnel.success.body} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="successCtaLabel">Button</Label>
            <Input id="successCtaLabel" name="successCtaLabel" maxLength={60} defaultValue={funnel.success.ctaLabel ?? ""} placeholder="Book a call" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="successCtaUrl">Button address</Label>
            <Input
              id="successCtaUrl"
              name="successCtaUrl"
              type="url"
              maxLength={500}
              defaultValue={funnel.success.ctaUrl ?? ""}
              placeholder="https://launchflow.co.uk/book"
            />
          </div>
        </div>
      </fieldset>

      <div>
        <Button type="submit">Save funnel</Button>
      </div>
    </ActionForm>
  );
}
