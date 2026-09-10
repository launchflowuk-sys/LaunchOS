import { MockSiteUploader, type SiteUploader } from "./upload.js";
import { SftpSiteUploader } from "./sftp.js";

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
  return new SftpSiteUploader({ host, port, username, password });
}
