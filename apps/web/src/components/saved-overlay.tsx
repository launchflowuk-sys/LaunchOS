"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * The confirmation a save gets: a card in the middle of the screen with a tick
 * that draws itself, not a coloured strip in the corner.
 *
 * A save is the moment the work landed, and the corner toast said so in green
 * for half a second somewhere the eye was not. This sits where the eye already
 * is, uses the workspace's own surface, border and radius rather than a status
 * colour, and leaves on its own. The only colour is the tick.
 *
 * Success only. A failure carries the provider's own words, needs reading time
 * and a dismiss, and stays on the toast where it can be read twice.
 */

const SHOW_MS = 1_400;
const LEAVE_MS = 220;

type Listener = (message: string) => void;
let listeners: Listener[] = [];

/**
 * The longest message the card can carry.
 *
 * The card is a confirmation you read at a glance and it leaves on its own.
 * A sentence that explains what happens next — "Queued. The Ops Brief agent is
 * writing it now…" — is not that, and putting it here would either shrink the
 * type or hold the screen. Those go to the toast, which stays put and can be
 * read twice.
 */
const CARD_MAX_CHARS = 48;

/**
 * Confirms a completed action. Short confirmations get the card; anything
 * longer falls through to the toast, so one call site covers both and no
 * screen has to decide which it wants.
 */
export function showSaved(message = "Saved"): void {
  if (message.length > CARD_MAX_CHARS) {
    toast.success(message);
    return;
  }
  for (const listener of listeners) listener(message);
}

export function SavedOverlay() {
  const [message, setMessage] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const listener: Listener = (next) => {
      setLeaving(false);
      setMessage(next);
    };
    listeners = [...listeners, listener];
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }, []);

  useEffect(() => {
    if (message === null) return;
    // Two timers rather than one: the card has to be told to leave before it
    // is unmounted, or the exit animation never runs.
    const out = setTimeout(() => setLeaving(true), SHOW_MS);
    const gone = setTimeout(() => setMessage(null), SHOW_MS + LEAVE_MS);
    return () => {
      clearTimeout(out);
      clearTimeout(gone);
    };
  }, [message]);

  if (message === null) return null;

  return (
    <div
      // `pointer-events-none` throughout: this is a confirmation, not a dialog.
      // It must never take a click away from the thing underneath it.
      className="pointer-events-none fixed inset-0 z-[100] grid place-items-center p-6"
      role="status"
      aria-live="polite"
    >
      <div className={`saved-card ${leaving ? "saved-card--leaving" : ""}`}>
        <svg viewBox="0 0 52 52" className="saved-tick" aria-hidden focusable="false">
          <circle className="saved-tick__ring" cx="26" cy="26" r="23" />
          <path className="saved-tick__check" d="M15 27.5 L22.5 35 L37 19" />
        </svg>
        <p className="saved-card__label">{message}</p>
      </div>
    </div>
  );
}
