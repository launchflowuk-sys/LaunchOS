"use client";

import { CalendarX2 } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { EmptyState } from "@/components/empty-state";
import {
  browserTimeZone,
  dayLabel,
  dayStrip,
  groupSlotsByDay,
  longDayLabel,
  type SlotView,
  zoneCity,
  zoneLabel,
} from "@/lib/booking/slot-days";
import { cn } from "@/lib/utils";

export type SlotPickerProps = {
  slots: readonly SlotView[];
  /** The window the slots were read for, ISO — the strip covers it day by day. */
  from: string;
  to: string;
  slotMinutes: number;
  /** The host's zone and first name, for the small line under a chosen time. */
  host: { timezone: string; firstName: string };
  /** The zone the page is in before the browser says otherwise (a guest moving their own call keeps theirs). */
  initialTimeZone?: string | undefined;
  /** Called with the chosen slot, or null when the choice is cleared. */
  onChange?: ((slot: SlotView | null) => void) | undefined;
};

/**
 * Pick a day, pick a time.
 *
 * The strip is three weeks of days in the visitor's own zone, closed days
 * greyed rather than missing; the times under it are the free slots that
 * fall on that day in that zone, with the host's clock shown small once one
 * is chosen. The zone is read from the browser after mount — a server render
 * cannot know it — so the first paint is London and the strip re-groups the
 * moment the page hydrates; the hidden inputs carry the instant and the zone
 * to the action so the confirmation email speaks the visitor's time.
 */
/** The browser's zone as an external store: null on the server render, the zone once hydrated. Never changes after that. */
const subscribeNever = () => () => {};
const noZoneOnServer = () => null;

export function SlotPicker({ slots, from, to, slotMinutes, host, initialTimeZone, onChange }: SlotPickerProps) {
  const detectedZone = useSyncExternalStore(subscribeNever, browserTimeZone, noZoneOnServer);
  const detected = detectedZone !== null;
  const timeZone = initialTimeZone ?? detectedZone ?? host.timezone;
  const [day, setDay] = useState<string | null>(null);
  const [chosen, setChosen] = useState<SlotView | null>(null);

  const byDay = useMemo(() => groupSlotsByDay(slots, timeZone), [slots, timeZone]);
  const days = useMemo(() => dayStrip(new Date(from), new Date(to), timeZone), [from, to, timeZone]);
  const firstOpen = days.find((key) => (byDay.get(key)?.length ?? 0) > 0) ?? null;
  const activeDay = day && byDay.has(day) ? day : firstOpen;
  const times = activeDay ? (byDay.get(activeDay) ?? []) : [];
  const now = new Date();

  function choose(slot: SlotView | null) {
    setChosen(slot);
    onChange?.(slot);
  }

  if (slots.length === 0) {
    return (
      <EmptyState icon={CalendarX2} title="No times free in the next few weeks">
        The diary is full for now. Reply to our email and we will find a time by hand.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-5" data-timezone={detected ? timeZone : undefined}>
      <div>
        <p className="text-sm font-medium">Pick a day</p>
        <p className="text-meta text-muted-foreground">
          Times are shown in your time zone{detected ? ` (${zoneCity(timeZone)}, ${zoneLabel(now, timeZone)})` : ""}.
        </p>
        <div className="scrollbar-none -mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1" role="listbox" aria-label="Day">
          {days.map((key) => {
            const count = byDay.get(key)?.length ?? 0;
            const label = dayLabel(key);
            const selected = key === activeDay;
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={count === 0}
                onClick={() => {
                  setDay(key);
                  choose(null);
                }}
                className={cn(
                  "flex w-16 shrink-0 flex-col items-center rounded-xl border px-2 py-2 text-sm transition-colors",
                  selected ? "border-primary bg-primary-soft text-primary" : "bg-card hover:border-muted-foreground/40",
                  count === 0 && "cursor-not-allowed border-dashed text-muted-foreground opacity-60 hover:border-border",
                )}
              >
                <span className="text-meta uppercase">{label.weekday}</span>
                <span className="text-lg leading-tight font-semibold tabular-nums">{label.day}</span>
                <span className="text-meta">{label.month}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium">{activeDay ? longDayLabel(activeDay) : "Pick a time"}</p>
        <p className="text-meta text-muted-foreground">{slotMinutes}-minute video call on Zoom.</p>
        {times.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nothing free on this day. Pick another.</p>
        ) : (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4" role="listbox" aria-label="Time">
            {times.map(({ slot, time }) => {
              const selected = chosen?.startsAt === slot.startsAt;
              return (
                <button
                  key={slot.startsAt}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(selected ? null : slot)}
                  className={cn(
                    "h-11 rounded-lg border text-base font-medium tabular-nums transition-colors",
                    selected ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary/60",
                  )}
                >
                  {time}
                </button>
              );
            })}
          </div>
        )}
        {chosen ? (
          <p className="mt-3 text-meta text-muted-foreground" data-chosen-host-time={chosen.hostTime}>
            {host.firstName}&rsquo;s time: {chosen.hostTime} {zoneLabel(new Date(chosen.startsAt), host.timezone)} ({zoneCity(host.timezone)}).
          </p>
        ) : null}
      </div>

      <input type="hidden" name="startsAt" value={chosen?.startsAt ?? ""} />
      <input type="hidden" name="guestTimezone" value={timeZone} />
    </div>
  );
}
