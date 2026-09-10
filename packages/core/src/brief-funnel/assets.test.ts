import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  assetsForSession, checkAsset, deleteAsset, displayName, MAX_BYTES_PER_FILE,
  MAX_FILES_PER_DRAFT, recordAsset, sniffType,
} from "./assets.js";
import { startBriefSession } from "./sessions.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");

/** A file's real bytes, whatever it claims to be called. */
async function attempt(db: Db, orgId: string, sessionId: string, name: string, bytes: Uint8Array) {
  return checkAsset(db, orgId, sessionId, { name, bytes });
}

describe("sniffType", () => {
  it("recognises the four formats we accept", () => {
    expect(sniffType(PNG)?.mime).toBe("image/png");
    expect(sniffType(JPEG)?.mime).toBe("image/jpeg");
    expect(sniffType(PDF)?.mime).toBe("application/pdf");
    expect(sniffType(WEBP)?.mime).toBe("image/webp");
  });

  /**
   * The whole point of sniffing. Both of these carry script, and both are
   * exactly what somebody would send to get code onto a staff screen.
   */
  it("refuses SVG and HTML however they are dressed up", () => {
    expect(sniffType(SVG)).toBeNull();
    expect(sniffType(HTML)).toBeNull();
  });

  it("refuses bytes it does not recognise", () => {
    expect(sniffType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toBeNull();
  });
});

describe("displayName", () => {
  it("keeps a name a person would recognise", () => {
    expect(displayName("my logo.png")).toBe("my logo.png");
    expect(displayName("Taylor-Plumbing brochure.pdf")).toBe("Taylor-Plumbing brochure.pdf");
  });

  it("strips paths and traversal", () => {
    expect(displayName("../../etc/passwd")).toBe("passwd");
    expect(displayName("C:\\Users\\sam\\logo.png")).toBe("logo.png");
  });

  /** A newline in a name is what splits a `content-disposition` header. */
  it("strips control characters", () => {
    expect(displayName('logo.png";\r\nX-Evil: 1')).not.toContain("\n");
    expect(displayName('logo.png";\r\nX-Evil: 1')).not.toContain("\r");
  });

  it("always returns something", () => {
    expect(displayName("")).toBe("attachment");
    expect(displayName("///")).toBe("attachment");
  });
});

describe("checkAsset", () => {
  it("accepts a real PNG and generates its own storage key", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);

      const result = await attempt(db, org.id, session.id, "logo.png", PNG);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.type.mime).toBe("image/png");
      // The customer's name never becomes part of the path.
      expect(result.storageKey).toMatch(new RegExp(`^brief/${session.id}/[0-9a-f-]+\\.png$`));
      expect(result.storageKey).not.toContain("logo");
    });
  });

  /**
   * The name is a label and the bytes are the truth. A `.png` full of script
   * is not a PNG.
   */
  it("refuses a script wearing a PNG extension", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);

      const result = await attempt(db, org.id, session.id, "logo.png", SVG);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("PNG, JPEG, WebP or PDF");
      // Never names what it detected — that would help somebody get past it.
      expect(result.reason).not.toContain("svg");
    });
  });

  it("refuses an empty file", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      const result = await attempt(db, org.id, session.id, "nothing.png", new Uint8Array());
      expect(result.ok).toBe(false);
    });
  });

  it("refuses a file over the size limit, and says the limit", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      const huge = new Uint8Array(MAX_BYTES_PER_FILE + 1);
      huge.set(PNG);

      const result = await attempt(db, org.id, session.id, "huge.png", huge);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("10MB");
    });
  });

  it("refuses more than the per-draft file count", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      for (let i = 0; i < MAX_FILES_PER_DRAFT; i += 1) {
        await recordAsset(db, org.id, session.id, {
          storageKey: `brief/${session.id}/${i}.png`, originalName: `${i}.png`,
          mime: "image/png", bytes: 100, checksum: "x",
        });
      }

      const result = await attempt(db, org.id, session.id, "one-too-many.png", PNG);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("Remove one first");
    });
  });

  it("refuses a file that would take the draft over its total", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      await recordAsset(db, org.id, session.id, {
        storageKey: `brief/${session.id}/big.pdf`, originalName: "big.pdf",
        mime: "application/pdf", bytes: 45 * 1024 * 1024, checksum: "x",
      });

      const big = new Uint8Array(9 * 1024 * 1024);
      big.set(PNG);
      const result = await attempt(db, org.id, session.id, "another.png", big);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("50MB");
    });
  });

  /** A removed file must not keep counting against the limits. */
  it("does not count deleted files towards the limits", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      for (let i = 0; i < MAX_FILES_PER_DRAFT; i += 1) {
        const asset = await recordAsset(db, org.id, session.id, {
          storageKey: `brief/${session.id}/${i}.png`, originalName: `${i}.png`,
          mime: "image/png", bytes: 100, checksum: "x",
        });
        if (i === 0) await deleteAsset(db, org.id, session.id, asset.id);
      }

      expect((await attempt(db, org.id, session.id, "fits.png", PNG)).ok).toBe(true);
    });
  });
});

describe("assetsForSession", () => {
  it("lists what is ready and not what was removed", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      const kept = await recordAsset(db, org.id, session.id, {
        storageKey: `brief/${session.id}/a.png`, originalName: "a.png", mime: "image/png", bytes: 10, checksum: "x",
      });
      const gone = await recordAsset(db, org.id, session.id, {
        storageKey: `brief/${session.id}/b.png`, originalName: "b.png", mime: "image/png", bytes: 10, checksum: "x",
      });
      await deleteAsset(db, org.id, session.id, gone.id);

      const listed = await assetsForSession(db, org.id, session.id);

      expect(listed.map((asset) => asset.id)).toEqual([kept.id]);
    });
  });
});

describe("deleteAsset", () => {
  /** The cookie proves which draft you are; it must not reach another one. */
  it("will not remove a file belonging to a different draft", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const mine = await startBriefSession(db, org.id);
      const theirs = await startBriefSession(db, org.id);
      const asset = await recordAsset(db, org.id, theirs.session.id, {
        storageKey: `brief/${theirs.session.id}/a.png`, originalName: "a.png", mime: "image/png", bytes: 10, checksum: "x",
      });

      expect(await deleteAsset(db, org.id, mine.session.id, asset.id)).toBeNull();

      const [row] = await db.select().from(schema.briefAssets).where(eq(schema.briefAssets.id, asset.id));
      expect(row!.status).toBe("ready");
    });
  });

  /** Kept as a tombstone: a reused storage key would serve the wrong file. */
  it("marks the row deleted rather than dropping it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      const asset = await recordAsset(db, org.id, session.id, {
        storageKey: `brief/${session.id}/a.png`, originalName: "a.png", mime: "image/png", bytes: 10, checksum: "x",
      });

      const removed = await deleteAsset(db, org.id, session.id, asset.id);

      expect(removed?.storageKey).toBe(`brief/${session.id}/a.png`);
      const [row] = await db.select().from(schema.briefAssets).where(eq(schema.briefAssets.id, asset.id));
      expect(row!.status).toBe("deleted");
    });
  });
});
