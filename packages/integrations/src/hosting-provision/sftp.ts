import SftpClient from "ssh2-sftp-client";
import type { SiteUploader, UploadFile } from "./upload.js";

/**
 * Puts the generated pages on the host over SFTP.
 *
 * Hostinger's API creates websites and installs WordPress but does not accept
 * files, so this is the step that makes a site look like anything at all.
 * Ordinary SFTP against the hosting account, on the port hPanel gives under
 * SSH Access — **65002, not 22**, which is the detail that costs an afternoon
 * when it is assumed.
 *
 * **One account reaches every site.** Every domain on the plan lives under
 * `/home/{username}/domains/{domain}/public_html`, including ones the API has
 * not created yet, so a single credential covers all of them. Per-domain FTP
 * users would mean an account to create and clean up per build, for no benefit:
 * nobody but LaunchOS writes these files.
 *
 * The connection is opened and closed per upload. A build happens every few
 * minutes at most, and a pooled SSH connection held across a worker's lifetime
 * is a thing that dies quietly and then fails the next write for reasons
 * nobody can see from the outside.
 */

export interface SftpUploaderOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Guards against a wedged connection holding a build's stage open for ever. */
  timeoutMs?: number | undefined;
}

export class SftpSiteUploader implements SiteUploader {
  readonly name = "sftp" as const;
  readonly live = true;

  constructor(private readonly options: SftpUploaderOptions) {}

  async upload(rootDirectory: string, files: readonly UploadFile[]): Promise<void> {
    // An empty upload would leave the client a blank page and report success.
    if (files.length === 0) throw new Error("nothing to upload: the generated site had no files");

    const root = rootDirectory.replace(/\/+$/, "");
    const client = new SftpClient();

    try {
      await client.connect({
        host: this.options.host,
        port: this.options.port,
        username: this.options.username,
        password: this.options.password,
        readyTimeout: this.options.timeoutMs ?? 30_000,
      });

      for (const file of files) {
        const target = `${root}/${file.path.replace(/^\/+/, "")}`;
        const folder = target.slice(0, target.lastIndexOf("/"));

        // Recursive and idempotent, and cheaper than asking first: a page at
        // `services/index.html` needs its folder, and most builds write several
        // pages into the same one.
        if (folder && folder !== root) await client.mkdir(folder, true).catch(() => undefined);

        await client.put(Buffer.from(file.contents, "utf8"), target);
      }
    } finally {
      // Always, including after a failure. A half-written upload that also
      // leaks its connection is two problems instead of one.
      await client.end().catch(() => undefined);
    }
  }
}
