import type { ContentChannelRow } from "@launchos/core";
import type { ContentChannel } from "@launchos/db/schema";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ChannelLabel } from "../../../content/presentation";
import { saveContentChannelAction } from "./actions";
import { GbpLocationField, InstagramIdField } from "./channel-id-fields";

type SiteOption = { id: string; name: string; primaryUrl: string; platform: string };

/** What the id is for each channel, in the words of the place you copy it from. */
const ID_FIELD: Record<Exclude<ContentChannel, "blog">, { label: string; placeholder: string; hint: string }> = {
  facebook: {
    label: "Facebook Page id",
    placeholder: "1234567890",
    hint: "Meta Business Suite → Page settings → the numeric id. The Page must be on the connected Business Manager.",
  },
  instagram: {
    label: "Instagram business account id",
    placeholder: "17841400000000000",
    hint: "The Instagram professional account linked to the Facebook Page — its numeric user id, not the @handle.",
  },
  gbp: {
    label: "Business Profile location",
    placeholder: "locations/1234567890",
    hint: "The location resource name from the Business Profile API, e.g. locations/1234567890.",
  },
};

const CHANNELS: readonly ContentChannel[] = ["facebook", "instagram", "blog", "gbp"];

/**
 * One row per channel, each its own form: connecting Facebook should not
 * re-post the Instagram id, and a row saves with a single button on a phone.
 * The blog is the odd one out — its id is one of the client's WordPress sites,
 * whose credentials already live on the site record.
 */
export function ChannelsForm({
  clientId,
  channels,
  sites,
  metaConfigured,
  gbpConfigured,
}: {
  clientId: string;
  channels: readonly ContentChannelRow[];
  sites: readonly SiteOption[];
  /** Whether the Meta keys are set — "Detect from Facebook page" needs them. */
  metaConfigured: boolean;
  /** Whether the GBP keys are set — "Find my locations" needs them. */
  gbpConfigured: boolean;
}) {
  const byChannel = new Map(channels.map((row) => [row.channel, row]));
  const facebookFieldId = "channel-facebook-id";
  const wordpressSites = sites.filter((site) => site.platform === "wordpress");

  return (
    <div className="grid gap-4">
      {CHANNELS.map((channel) => {
        const row = byChannel.get(channel);
        const fieldId = `channel-${channel}-id`;
        return (
          <ActionForm
            key={channel}
            action={saveContentChannelAction}
            ariaLabel={`Connect ${channel}`}
            success="Channel saved"
            className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] sm:items-end"
          >
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="channel" value={channel} />
            <div className="min-w-0 space-y-1.5 sm:col-span-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  <ChannelLabel channel={channel} />
                </span>
                <span className="text-meta text-muted-foreground">
                  {row ? (row.enabled ? `Connected${row.displayName ? ` · ${row.displayName}` : ""}` : "Connected, switched off") : "Not connected"}
                </span>
              </div>
            </div>
            {channel === "blog" ? (
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={fieldId}>WordPress site</Label>
                <NativeSelect id={fieldId} name="externalId" defaultValue={row?.externalId ?? ""} required>
                  <option value="" disabled>
                    {wordpressSites.length === 0 ? "No WordPress site on this client" : "Choose a site"}
                  </option>
                  {wordpressSites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name} — {site.primaryUrl}
                    </option>
                  ))}
                </NativeSelect>
                <p className="text-meta text-muted-foreground">Posts publish with the WordPress app password saved on the site.</p>
              </div>
            ) : channel === "instagram" ? (
              <InstagramIdField
                fieldId={fieldId}
                defaultValue={row?.externalId ?? ""}
                facebookFieldId={facebookFieldId}
                savedPageId={byChannel.get("facebook")?.externalId ?? null}
                metaConfigured={metaConfigured}
                {...ID_FIELD.instagram}
              />
            ) : channel === "gbp" ? (
              <GbpLocationField
                fieldId={fieldId}
                defaultValue={row?.externalId ?? ""}
                gbpConfigured={gbpConfigured}
                {...ID_FIELD.gbp}
              />
            ) : (
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={fieldId}>{ID_FIELD[channel].label}</Label>
                <Input id={fieldId} name="externalId" defaultValue={row?.externalId ?? ""} placeholder={ID_FIELD[channel].placeholder} required />
                <p className="text-meta text-muted-foreground">{ID_FIELD[channel].hint}</p>
              </div>
            )}
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`channel-${channel}-name`}>Shown as</Label>
              <Input id={`channel-${channel}-name`} name="displayName" defaultValue={row?.displayName ?? ""} placeholder="Grays CabLine" maxLength={200} />
              <p className="text-meta text-muted-foreground">A label for this screen only.</p>
            </div>
            <div className="min-w-0 space-y-1.5 sm:w-32">
              <Label htmlFor={`channel-${channel}-enabled`}>Publishing</Label>
              <NativeSelect id={`channel-${channel}-enabled`} name="enabled" defaultValue={row && !row.enabled ? "false" : "true"}>
                <option value="true">On</option>
                <option value="false">Off</option>
              </NativeSelect>
            </div>
            <Button type="submit" variant="secondary" className="max-sm:w-full">
              Save
            </Button>
          </ActionForm>
        );
      })}
    </div>
  );
}
