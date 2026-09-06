import { type BookingSettings, DAY_KEYS } from "@launchos/core";
import { ActionForm } from "@/components/action-form";
import { KeyValue } from "@/components/key-value";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { updateBookingSettingsAction } from "./actions";
import { DAY_LABEL, hoursDefaults, hoursFieldNames, TIMEZONE_CHOICES } from "./booking-form";

export type HostChoice = { userId: string; label: string };

function NumberField({ name, label, defaultValue, hint, min, max }: { name: string; label: string; defaultValue: number; hint: string; min: number; max: number }) {
  return (
    <div>
      <Label htmlFor={`booking-${name}`}>{label}</Label>
      <Input id={`booking-${name}`} name={name} type="number" inputMode="numeric" min={min} max={max} step={1} defaultValue={defaultValue} required className="mt-1.5" />
      <p className="mt-1.5 text-meta text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Settings → Organisation → Booking: the hours the public booking page
 * offers, in the host's zone, with the slot length, the buffer between
 * calls, how much notice a booking needs, how far ahead it may be, and whose
 * diary it is. Plain HTML inputs posted whole, like the rest of the page; a
 * day with both times blank is closed.
 */
export function BookingSection({ settings, hosts, canEdit }: { settings: BookingSettings; hosts: readonly HostChoice[]; canEdit: boolean }) {
  const zones = TIMEZONE_CHOICES.includes(settings.timezone) ? TIMEZONE_CHOICES : [settings.timezone, ...TIMEZONE_CHOICES];
  const currentHost = hosts.find((h) => h.userId === settings.hostUserId)?.label ?? "The owner";
  const openDays = DAY_KEYS.filter((day) => settings.hours[day].length > 0);

  return (
    <Section
      title="Booking"
      description="When a lead or client can book a call on the booking page. Times are in the zone below and shown to each visitor in their own; the diary is the host's, so a booked slot blocks them everywhere."
    >
      {canEdit ? (
        <ActionForm
          action={updateBookingSettingsAction}
          ariaLabel="Booking settings"
          success="Booking settings saved"
          className="space-y-5 rounded-xl border bg-card p-4 sm:p-5"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="booking-timezone">Time zone</Label>
              <NativeSelect id="booking-timezone" name="timezone" defaultValue={settings.timezone} className="mt-1.5">
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </option>
                ))}
              </NativeSelect>
              <p className="mt-1.5 text-meta text-muted-foreground">The hours below are in this zone. Keep it London so the hours follow UK clients wherever you are.</p>
            </div>
            <div>
              <Label htmlFor="booking-hostUserId">Host</Label>
              <NativeSelect id="booking-hostUserId" name="hostUserId" defaultValue={settings.hostUserId ?? ""} className="mt-1.5">
                <option value="">The owner</option>
                {hosts.map((host) => (
                  <option key={host.userId} value={host.userId}>
                    {host.label}
                  </option>
                ))}
              </NativeSelect>
              <p className="mt-1.5 text-meta text-muted-foreground">Whose diary the calls go in and who gets the bell and the host link.</p>
            </div>
            <NumberField name="slotMinutes" label="Slot length (minutes)" defaultValue={settings.slotMinutes} min={10} max={240} hint="How long each call is. 30 suits a discovery call." />
            <NumberField name="bufferMinutes" label="Buffer between calls (minutes)" defaultValue={settings.bufferMinutes} min={0} max={120} hint="Breathing room either side of a booked call." />
            <NumberField name="minNoticeHours" label="Minimum notice (hours)" defaultValue={settings.minNoticeHours} min={0} max={168} hint="The earliest a visitor may book from now." />
            <NumberField name="horizonDays" label="Book up to (days ahead)" defaultValue={settings.horizonDays} min={1} max={90} hint="How far ahead the page offers times." />
          </div>

          <fieldset>
            <legend className="text-sm font-medium">Hours per day</legend>
            <p className="mt-1 text-meta text-muted-foreground">Opening and closing time. Leave both blank to close the day.</p>
            <div className="mt-3 grid gap-2">
              {DAY_KEYS.map((day) => {
                const names = hoursFieldNames(day);
                const defaults = hoursDefaults(settings.hours, day);
                return (
                  <div key={day} className="grid grid-cols-[6rem_1fr_auto_1fr] items-center gap-2 sm:grid-cols-[8rem_10rem_auto_10rem]">
                    <span className="text-sm">{DAY_LABEL[day]}</span>
                    <Input type="time" name={names.from} defaultValue={defaults.from} aria-label={`${DAY_LABEL[day]} from`} step={300} />
                    <span className="text-meta text-muted-foreground">to</span>
                    <Input type="time" name={names.to} defaultValue={defaults.to} aria-label={`${DAY_LABEL[day]} to`} step={300} />
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div className="flex justify-end max-sm:[&>*]:w-full">
            <Button type="submit">Save booking settings</Button>
          </div>
        </ActionForm>
      ) : (
        <div className="rounded-xl border bg-card p-4 sm:p-5">
          <KeyValue
            columns={2}
            items={[
              { label: "Time zone", value: settings.timezone },
              { label: "Host", value: currentHost },
              { label: "Slot", value: `${settings.slotMinutes} min, ${settings.bufferMinutes} min buffer` },
              { label: "Notice and horizon", value: `${settings.minNoticeHours} h notice, ${settings.horizonDays} days ahead` },
              {
                label: "Open",
                value: openDays.length === 0 ? "Closed every day" : openDays.map((day) => `${DAY_LABEL[day].slice(0, 3)} ${settings.hours[day].map(([a, b]) => `${a}–${b}`).join(", ")}`).join(" · "),
              },
            ]}
          />
          <p className="mt-4 text-meta text-muted-foreground">Only a member with the settings permission can change these.</p>
        </div>
      )}
    </Section>
  );
}
