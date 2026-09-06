import { closePdfRenderer, pdfRenderer } from "@launchos/channels/pdf";

/**
 * The browser's lifetime, tied to the worker's.
 *
 * The renderer itself is a process singleton in `@launchos/channels/pdf`, and
 * it launches lazily — a worker that never renders a document never starts
 * Chromium, which matters because most of what this process does is queues and
 * cron. What is missing without this file is the other end: nothing was
 * closing it.
 *
 * A leaked headless Chromium is not a tidy-up job, it is a container that
 * refuses to stop. Coolify sends SIGTERM on a redeploy and waits; Node's
 * default handling of SIGTERM is to exit, but only *once nothing else is
 * holding the loop open*, and a live browser process does exactly that. The
 * deploy then sits until the ten-second grace period runs out and Docker sends
 * SIGKILL — every time, on every release.
 *
 * So the handler here closes the browser and then gets out of the way: it
 * removes itself and re-raises the same signal, so the process dies of the
 * signal it was sent, with the exit code the platform expects, and whatever
 * shutdown work a later release adds can register its own handler without
 * fighting this one over `process.exit`.
 */

export interface PdfShutdownOptions {
  readonly logger?: Pick<Console, "info" | "error">;
  /** The signals to close on. Overridden by the tests. */
  readonly signals?: readonly NodeJS.Signals[];
}

/** SIGTERM is Docker and Coolify; SIGINT is Ctrl-C in `pnpm dev:worker`. */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

export function installPdfShutdown(options: PdfShutdownOptions = {}): void {
  const logger = options.logger ?? console;
  for (const signal of options.signals ?? SHUTDOWN_SIGNALS) {
    const handler = async () => {
      try {
        await closePdfRenderer();
      } catch (error) {
        // Never let a failed browser close stop the process from stopping —
        // the whole point of this handler is that shutdown always completes.
        logger.error({ err: error }, "closing the document renderer failed");
      }
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
  }
}

/**
 * Which engine this worker will render documents with, for the startup line.
 *
 * Reading it here also *builds* the renderer, which is deliberate: building it
 * is cheap (no browser is launched until the first render) and doing it at
 * boot means a misconfigured `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is a fact
 * in the log from the first second rather than a surprise at month end.
 */
export function pdfRendererName(env: NodeJS.ProcessEnv = process.env): string {
  return pdfRenderer(env).kind;
}
