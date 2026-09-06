import { MockPushAdapter } from "./mock.js";
import { WebPushAdapter, isValidVapidSubject } from "./web-push.js";
import type { PushAdapter } from "./types.js";

/**
 * The pair that selects the real adapter. Both set → web push; neither → the
 * mock; one without the other is named at boot by the adapter guard
 * (`packages/integrations/src/adapter-guard.ts`, `resolvePush`), which
 * mirrors this factory line by line.
 */
export const PUSH_ENV_KEYS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;

/** Blank is unset — the same rule as `createEmailAdapter` and the worker's env parser. */
function trimmedOrUnset(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Whether both VAPID keys are set, blank counting as unset. */
export function hasPushCredentials(env: NodeJS.ProcessEnv): boolean {
  return PUSH_ENV_KEYS.every((key) => trimmedOrUnset(env[key]) !== undefined);
}

/** Why `createPushAdapterFromEnv` would throw for this environment, or null when it builds. Mirrored by the adapter guard. */
export function pushSubjectProblem(env: NodeJS.ProcessEnv): string | null {
  const subject = trimmedOrUnset(env.VAPID_SUBJECT);
  if (subject === undefined) {
    return "VAPID_SUBJECT is required when VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set (a mailto: address, e.g. mailto:shoji@launchflow.co.uk)";
  }
  if (!isValidVapidSubject(subject)) return `VAPID_SUBJECT must be a mailto: address or an https: URL, got ${JSON.stringify(subject)}`;
  return null;
}

/**
 * Web push when both VAPID keys are set, the mock otherwise — mock-first,
 * per CLAUDE.md rule 4. With the keys set, `VAPID_SUBJECT` must also be set
 * and well-formed (`mailto:` or `https:`), and the factory throws rather than
 * downgrading: a worker that believed it was pushing while sending nothing
 * is the failure the adapter guard exists to make loud.
 */
export function createPushAdapterFromEnv(env: NodeJS.ProcessEnv): PushAdapter {
  if (!hasPushCredentials(env)) return new MockPushAdapter();
  const problem = pushSubjectProblem(env);
  if (problem !== null) throw new Error(problem);
  return new WebPushAdapter({
    vapid: {
      subject: trimmedOrUnset(env.VAPID_SUBJECT) as string,
      publicKey: trimmedOrUnset(env.VAPID_PUBLIC_KEY) as string,
      privateKey: trimmedOrUnset(env.VAPID_PRIVATE_KEY) as string,
    },
  });
}
