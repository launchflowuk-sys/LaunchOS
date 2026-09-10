import { MockSiteUploader, type SiteUploader } from "./upload.js";

/**
 * Mock unless the whole SFTP credential is present — mock-first, per rule 4.
 *
 * All four, not some. A partial credential cannot connect, and falling back to
 * the mock on a missing password would mean a build reporting a successful
 * upload having written nothing — the client opens a blank page and nobody
 * finds out until they say so. Either it can really upload, or it plainly
 * cannot.
 *
 * Port 65002 is Hostinger's, not the SSH default. It is still read from the
 * environment rather than hardcoded, because it is theirs to change.
 */
export function createSiteUploaderFromEnv(env: NodeJS.ProcessEnv = process.env): SiteUploader {
  const host = env.HOSTINGER_SFTP_HOST?.trim();
  const username = env.HOSTINGER_SFTP_USER?.trim();
  const password = env.HOSTINGER_SFTP_PASSWORD?.trim();
  const port = Number(env.HOSTINGER_SFTP_PORT ?? 65002);

  if (!host || !username || !password || !Number.isFinite(port)) return new MockSiteUploader();

  // The real SFTP uploader is not wired yet. `ssh2-sftp-client` pulls an
  // optional native accelerator whose build script pnpm will not run without
  // `pnpm approve-builds`, an interactive command — and until it is approved,
  // `pnpm install` exits non-zero and the whole repo's test runner stops. That
  // is one command for a person and not something to leave half-done.
  //
  // Throwing rather than falling back to the mock is deliberate: a full
  // credential means somebody expects real uploads, and quietly writing nothing
  // would mean a build reporting success with a blank site behind it.
  throw new Error(
    "SFTP credentials are set but the uploader is not wired: run `pnpm approve-builds`, "
    + "add ssh2-sftp-client, and restore SftpSiteUploader.",
  );
}
