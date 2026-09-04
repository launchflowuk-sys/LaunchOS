import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentContentDisposition, safeExtension, storeInboundAttachments } from "./attachments.js";

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

  it("copies only a plain extension onto the stored name, so a quote cannot reach content-disposition", async () => {
    // `extname` copies everything after the last dot verbatim, and the name is
    // chosen by whoever sent the mail. Stored with the suffix intact, the
    // download route emitted `filename="<uuid>.pdf"; filename*=UTF-8''setup%2Eexe"`
    // and the browser saved the bytes as `setup.exe`, because RFC 6266 prefers
    // `filename*`.
    const dir = await mkdtemp(join(tmpdir(), "launchos-"));
    const hostile = `a.pdf"; filename*=UTF-8''setup%2Eexe`;
    const [stored] = await storeInboundAttachments("org", [{ name: hostile, contentType: "application/pdf", contentBase64: "aGk=" }], { STORAGE_DIR: dir });
    const file = stored!.url.split("/").pop()!;
    expect(file).not.toContain('"');
    expect(file).not.toContain("filename*");
    expect(file).toMatch(/^[0-9a-f-]{36}$/);
    // The readable name is still kept as a label — it is never a path segment.
    expect(stored!.name).toBe(hostile);
  });

  it("keeps a plain extension, lowercased, and drops anything else", () => {
    expect(safeExtension("report.PDF")).toBe(".pdf");
    expect(safeExtension("archive.tar.gz")).toBe(".gz");
    expect(safeExtension("no-extension")).toBe("");
    expect(safeExtension(`a.pdf"; filename*=UTF-8''setup%2Eexe`)).toBe("");
    expect(safeExtension("a.thisextensioniswaytoolong")).toBe("");
    expect(safeExtension("trailing.")).toBe("");
  });

  it("builds a content-disposition that cannot carry a forged filename* parameter", () => {
    expect(attachmentContentDisposition("report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    const forged = attachmentContentDisposition(`a.pdf"; filename*=UTF-8''setup%2Eexe`);
    expect(forged).toBe(`attachment; filename="a.pdf___filename__UTF-8__setup_2Eexe"; filename*=UTF-8''a.pdf%22%3B%20filename%2A%3DUTF-8%27%27setup%252Eexe`);
    // One `filename*`, and it is ours.
    expect(forged.match(/filename\*/g)).toHaveLength(1);
    expect(forged).not.toContain(`"; filename*=UTF-8''setup`);
  });

  it("refuses a filename that tries to escape the organisation directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launchos-"));
    const [stored] = await storeInboundAttachments("org", [{ name: "../../etc/passwd", contentType: "text/plain", contentBase64: "aGk=" }], { STORAGE_DIR: dir });
    expect(stored!.name).toBe("passwd");
    expect(stored!.url).not.toContain("..");
  });
});
