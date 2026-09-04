import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storeInboundAttachments } from "./attachments.js";

describe("storeInboundAttachments", () => {
  it("writes each attachment under STORAGE_DIR and returns its metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launchos-"));
    const org = "11111111-1111-1111-1111-111111111111";
    const [stored] = await storeInboundAttachments(org, [{ name: "note.txt", contentType: "text/plain", contentBase64: "aGk=" }], { STORAGE_DIR: dir });
    expect(stored!.size).toBe(2);
    expect(stored!.url).toMatch(new RegExp(`^/api/attachments/${org}/`));
    const file = join(dir, "attachments", org, stored!.url.split("/").pop()!);
    expect(await readFile(file, "utf8")).toBe("hi");
  });

  it("refuses a filename that tries to escape the organisation directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launchos-"));
    const [stored] = await storeInboundAttachments("org", [{ name: "../../etc/passwd", contentType: "text/plain", contentBase64: "aGk=" }], { STORAGE_DIR: dir });
    expect(stored!.name).toBe("passwd");
    expect(stored!.url).not.toContain("..");
  });
});
