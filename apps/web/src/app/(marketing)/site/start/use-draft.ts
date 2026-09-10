"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The draft, and everything that makes "Saved" true.
 *
 * Deliberately does not import from `@launchos/core` — this is a client
 * component, and a value import from core drags the database driver into the
 * browser bundle. The API's shapes are declared here instead.
 *
 * Three rules hold this together:
 *
 * 1. **One write at a time, in order.** Writes queue behind each other rather
 *    than racing. Two in flight at once means two claiming the same expected
 *    revision, and the second losing to a conflict it should never have had.
 * 2. **"Saved" only after the server says so.** The revision comes back from
 *    the database; nothing here guesses it.
 * 3. **Unacknowledged edits live in memory only.** No answers in
 *    `localStorage`: it survives longer than the person expects, and it is
 *    their business details.
 */

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface DraftSession {
  id: string;
  revision: number;
  currentStep: number;
  completedSteps: number[];
  answers: Record<string, unknown>;
  status: "draft" | "submitted" | "expired";
  leadCaptured: boolean;
}

/** How long after the last keystroke a save goes out. */
const DEBOUNCE_MS = 600;

interface Pending {
  fields: Record<string, unknown>;
  mutationId: string;
}

export function useDraft() {
  const [session, setSession] = useState<DraftSession | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  /**
   * The revision as the server last confirmed it. A ref rather than state
   * because the write loop reads it between awaits, where a stale closure over
   * a state value would send a revision that is already old.
   */
  const revision = useRef(0);
  const queue = useRef<Pending[]>([]);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Edits typed but not yet queued — merged into the next outgoing write. */
  const buffered = useRef<Record<string, unknown>>({});
  /** One per journey, not one per press. See `submit`. */
  const idempotencyKey = useRef<string | null>(null);

  /** Opens the existing draft, or starts one. Runs once. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const existing = await fetch("/api/brief-funnel/session", { cache: "no-store" });
      if (cancelled) return;
      if (existing.ok) {
        const body = (await existing.json()) as { session: DraftSession };
        revision.current = body.session.revision;
        setSession(body.session);
        setReady(true);
        return;
      }
      const source = sourceFromLocation();
      const started = await fetch("/api/brief-funnel/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      });
      if (cancelled || !started.ok) {
        setReady(true);
        return;
      }
      const body = (await started.json()) as { session: DraftSession };
      revision.current = body.session.revision;
      setSession(body.session);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Drains the queue, one write at a time.
   *
   * Re-entrant by design: `inFlight` is the lock, and the loop picks up
   * anything queued while a request was out, so a burst of typing collapses
   * into as few writes as the network allows without any of them overtaking
   * another.
   */
  const drain = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      while (queue.current.length > 0) {
        const next = queue.current.shift()!;
        setSaveState("saving");
        const response = await fetch("/api/brief-funnel/session", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mutationId: next.mutationId,
            expectedRevision: revision.current,
            fields: next.fields,
          }),
        });

        if (response.status === 409) {
          // Another tab moved ahead. Take its state as the base and put our
          // fields back at the front — they are the newer intent for those
          // keys, and everything else it changed is kept.
          const body = (await response.json()) as { currentRevision: number; answers: Record<string, unknown> };
          revision.current = body.currentRevision;
          setSession((current) => (current ? { ...current, revision: body.currentRevision, answers: { ...body.answers, ...next.fields } } : current));
          queue.current.unshift({ ...next, mutationId: crypto.randomUUID() });
          continue;
        }

        if (!response.ok) {
          // Back on the queue, untouched. The same mutation id is what makes
          // the retry safe if the server did in fact commit it.
          queue.current.unshift(next);
          const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
          setSaveError(body?.error?.message ?? "That did not save. We will try again.");
          setSaveState("error");
          return;
        }

        const body = (await response.json()) as { revision: number; leadCaptured: boolean };
        revision.current = body.revision;
        setSession((current) =>
          current ? { ...current, revision: body.revision, answers: { ...current.answers, ...next.fields }, leadCaptured: body.leadCaptured } : current,
        );
        setSaveError(null);
        setSaveState("saved");
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  /** Moves whatever has been typed onto the queue and starts a write. */
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const fields = buffered.current;
    buffered.current = {};
    if (Object.keys(fields).length > 0) queue.current.push({ fields, mutationId: crypto.randomUUID() });
    await drain();
  }, [drain]);

  /**
   * Records a change. Shown immediately, saved shortly after.
   *
   * The optimistic local update is what keeps typing responsive; the save
   * state is what tells the truth about whether it is anywhere yet. Those are
   * two different things and the UI must not conflate them.
   */
  const setField = useCallback(
    (key: string, value: unknown) => {
      buffered.current = { ...buffered.current, [key]: value };
      setSession((current) => (current ? { ...current, answers: { ...current.answers, [key]: value } } : current));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush],
  );

  /**
   * Finishes a step. Flushes first, so the server validates what the customer
   * can see rather than what it happened to have received.
   */
  const completeStep = useCallback(
    async (step: number): Promise<{ ok: boolean; errors: Record<string, string> }> => {
      await flush();
      const response = await fetch("/api/brief-funnel/session", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step }),
      });
      if (response.status === 422) {
        const body = (await response.json()) as { errors: Record<string, string> };
        return { ok: false, errors: body.errors };
      }
      if (!response.ok) return { ok: false, errors: { _: "That did not save. Try again in a moment." } };
      const body = (await response.json()) as { currentStep: number; completedSteps: number[] };
      setSession((current) => (current ? { ...current, ...body } : current));
      return { ok: true, errors: {} };
    },
    [flush],
  );

  /**
   * Sends the brief.
   *
   * The idempotency key is generated once per journey and reused for every
   * attempt, so a double tap, a retried timeout and a refresh mid-request all
   * resolve to one submission and one reference. Generating it per press would
   * defeat the whole mechanism.
   */
  const submit = useCallback(async (): Promise<
    { ok: true; reference: string } | { ok: false; errors: Record<string, string> }
  > => {
    await flush();
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    const response = await fetch("/api/brief-funnel/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: idempotencyKey.current, expectedRevision: revision.current }),
    });
    if (response.status === 422) {
      const body = (await response.json()) as { errors: Record<string, string> };
      return { ok: false, errors: body.errors };
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      return { ok: false, errors: { _: body?.error?.message ?? "That did not send. Try again in a moment." } };
    }
    const body = (await response.json()) as { reference: string };
    return { ok: true, reference: body.reference };
  }, [flush]);

  /**
   * A last try on the way out. Best effort and nothing more — the durable
   * path is the debounced save, and this only narrows the window between the
   * last keystroke and it.
   */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flush]);

  return { session, ready, saveState, saveError, setField, flush, completeStep, submit, retry: flush };
}

/**
 * Campaign metadata off the URL, and nothing else.
 *
 * An allow-list because the server keeps one too — but doing it here as well
 * means contact details never leave the page in the first place, rather than
 * being sent and then discarded.
 */
function sourceFromLocation(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const out: Record<string, string> = { entry_route: window.location.pathname };
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
    const value = params.get(key);
    if (value) out[key] = value;
  }
  return out;
}
