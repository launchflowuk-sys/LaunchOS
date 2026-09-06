/**
 * The words on the admin shell's worker banner. Pure, so it can be tested
 * without a heartbeat row; the layout feeds it `checkWorkerDown`'s answer.
 */
export type WorkerBannerInput = {
  down: boolean;
  seenAt: Date | null;
  ageMs: number | null;
};

/** The banner's sentence, or null when the worker is fine. */
export function workerDownMessage(status: WorkerBannerInput): string | null {
  if (!status.down) return null;
  if (status.seenAt === null || status.ageMs === null) {
    return "Background worker has never checked in — cron jobs, emails, agent runs and publishing are not running.";
  }
  const minutes = Math.floor(status.ageMs / 60_000);
  const unit = minutes === 1 ? "minute" : "minutes";
  return `Background worker has not checked in for ${minutes} ${unit} — cron jobs, emails, agent runs and publishing are paused until it is back.`;
}
