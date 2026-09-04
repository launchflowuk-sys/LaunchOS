import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Session = { userId: string; email: string; organisationId: string; role: "owner" | "staff" };

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn<() => Promise<Session>>() }));
vi.mock("@/lib/session", () => ({ requireAdmin: requireAdminMock }));

import { GET } from "./route.js";

function ctx(org: string, file: string): { params: Promise<{ org: string; file: string }> } {
  return { params: Promise.resolve({ org, file }) };
}

describe("GET /api/attachments/[org]/[file]", () => {
  let storageDir: string;
  let orgId: string;
  const originalStorageDir = process.env.STORAGE_DIR;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "launchos-attach-"));
    process.env.STORAGE_DIR = storageDir;
    orgId = randomUUID();
    requireAdminMock.mockResolvedValue({ userId: "u1", email: "a@b.com", organisationId: orgId, role: "owner" });
  });

  afterEach(async () => {
    process.env.STORAGE_DIR = originalStorageDir;
    await rm(storageDir, { recursive: true, force: true });
  });

  it("serves a file that belongs to the signed-in admin's organisation", async () => {
    const dir = join(storageDir, "attachments", orgId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "report.pdf"), "pdf-bytes");

    const res = await GET(new Request("http://localhost/api/attachments/x/report.pdf"), ctx(orgId, "report.pdf"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition"))
      .toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(await res.text()).toBe("pdf-bytes");
  });

  it("encodes the name into content-disposition rather than interpolating it", async () => {
    // The stored name descends from an attacker-supplied attachment name, so a
    // character that ends the quoted string would otherwise forge a second
    // `filename*` — which RFC 6266 prefers over the real one, letting the sender
    // choose the name the browser saves under. `"` and `*` are not legal in a
    // Windows filename, so the hostile shape itself is asserted against
    // `attachmentContentDisposition` in packages/channels; this is the route
    // wiring, on a name a filesystem will accept.
    const dir = join(storageDir, "attachments", orgId);
    await mkdir(dir, { recursive: true });
    const odd = "re;port é.pdf";
    await writeFile(join(dir, odd), "pdf-bytes");

    const res = await GET(new Request("http://localhost/api/attachments/x/x"), ctx(orgId, odd));

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition")!;
    expect(disposition).toBe(`attachment; filename="re_port__.pdf"; filename*=UTF-8''re%3Bport%20%C3%A9.pdf`);
    expect(disposition.match(/filename\*/g)).toHaveLength(1);
  });

  it("returns 404 when the org segment does not match the caller's organisation", async () => {
    const otherOrg = randomUUID();
    const dir = join(storageDir, "attachments", otherOrg);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "report.pdf"), "pdf-bytes");

    const res = await GET(new Request("http://localhost/api/attachments/x/report.pdf"), ctx(otherOrg, "report.pdf"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a file that does not exist on disk", async () => {
    const res = await GET(new Request("http://localhost/api/attachments/x/missing.pdf"), ctx(orgId, "missing.pdf"));
    expect(res.status).toBe(404);
  });

  it("reduces a traversal attempt in the file segment to its basename, so it never escapes the org directory", async () => {
    await writeFile(join(storageDir, "secret.txt"), "top-secret");
    const dir = join(storageDir, "attachments", orgId);
    await mkdir(dir, { recursive: true });

    const res = await GET(new Request("http://localhost/api/attachments/x/x"), ctx(orgId, "../../secret.txt"));
    expect(res.status).toBe(404);
  });
});
