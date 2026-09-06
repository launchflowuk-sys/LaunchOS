/**
 * Node-runtime half of `onRequestError` (`src/instrumentation.ts`): turns a
 * server error into a `system.error` notification for the owner through
 * core's `noteSystemError`, which throttles to one per signature per hour.
 *
 * In its own file for the same reason as `instrumentation-node.ts`: the Edge
 * compilation of the instrumentation module must never see `@launchos/core`
 * (nodemailer and the postgres driver sit behind that barrel).
 */
import { noteSystemError } from "@launchos/core";
import { getDb } from "./lib/db";
import { describeRequestError, type RequestErrorContext } from "./lib/request-error";

export async function reportRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: RequestErrorContext,
): Promise<void> {
  const report = describeRequestError(error, request, context);
  if (!report) return;
  try {
    // No organisation: a request error is not reliably attributable to one
    // (the session may be what failed), and `noteSystemError` tells every
    // active organisation's owner — which today is Shoji.
    await noteSystemError(getDb(), { source: "web", ...report });
  } catch (cause) {
    // An alert about an error must never become a second error.
    console.error("[instrumentation] system error could not be recorded", { signature: report.signature, cause });
  }
}
