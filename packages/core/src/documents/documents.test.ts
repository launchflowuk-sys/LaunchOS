import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { tinyPdf } from "@launchos/channels/pdf";
import { createClient } from "../clients/create-client.js";
import { setEnqueue } from "../events/emit.js";
import { SecretsKeyError } from "../secrets/encryption.js";
import {
  DEFAULT_DOCUMENT_LINK_TTL_SECONDS,
  DOCUMENT_ROUTE_PATH,
  MAX_DOCUMENT_LINK_TTL_SECONDS,
  signDocumentToken,
  signedDocumentUrl,
  verifyDocumentToken,
} from "./document-link.js";
import { documentContentDisposition, readDocumentForClient, readDocumentForOwner, readSignedDocument } from "./read-document.js";
import { DocumentRefused, documentFilePath, getDocument, listDocuments, storeDocument } from "./store-document.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-documents-"));
const ENV = {
  STORAGE_DIR: storage,
  SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  APP_URL: "https://os.launchflow.test",
};
/** A second deployment's key — a signature minted with it must not verify here. */
const OTHER_ENV = { ...ENV, SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

const PDF = tinyPdf("Proposal P-2026-014");

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${randomUUID()}` }).returning();
  const [other] = await db.insert(schema.organisations).values({ name: "Other", slug: `o-${randomUUID()}` }).returning();
  const [owner] = await db
    .insert(schema.user)
    .values({ id: randomUUID(), name: "Shoji", email: `owner-${randomUUID()}@example.test`, emailVerified: true })
    .returning();
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: owner!.id, role: "owner", status: "active" });
  const client = await createClient(db, org!.id, { name: "Acme" });
  const rival = await createClient(db, org!.id, { name: "Rival" });
  return { organisationId: org!.id, otherOrganisationId: other!.id, ownerId: owner!.id, client, rival };
}

const PROPOSAL = { kind: "proposal" as const, title: "Proposal for Acme Ltd", reference: "P-2026-014" };

describe("storeDocument", () => {
  it("writes the bytes, records the row with its digest, and audits the write", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerId, client } = await fixture(db);

      const document = await storeDocument(
        db,
        organisationId,
        { ...PROPOSAL, clientId: client.id, subjectType: "proposal", subjectId: randomUUID(), bytes: PDF, actorId: ownerId },
        ENV,
      );

      expect(document).toMatchObject({
        organisationId, clientId: client.id, kind: "proposal", reference: "P-2026-014",
        mime: "application/pdf", sizeBytes: PDF.byteLength, createdByUserId: ownerId,
      });
      expect(document.path).toBe(`documents/${organisationId}/${document.id}.pdf`);
      expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await stat(documentFilePath(document, ENV))).size).toBe(PDF.byteLength);

      const [audit] = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.targetId, document.id), eq(schema.auditLog.action, "document.stored")));
      expect(audit).toMatchObject({ organisationId, targetType: "document", actorKind: "user", actorId: ownerId });
    });
  });

  it("keeps a lead's proposal with no client, and stores a countersigned copy as a second document", async () => {
    await withTestDb(async (db) => {
      const { organisationId, client } = await fixture(db);
      const subjectId = randomUUID();

      const sent = await storeDocument(db, organisationId, { ...PROPOSAL, subjectType: "proposal", subjectId, bytes: PDF, actorKind: "system" }, ENV);
      expect(sent.clientId).toBeNull();

      const signed = await storeDocument(
        db, organisationId,
        { ...PROPOSAL, kind: "proposal_signed", clientId: client.id, subjectType: "proposal", subjectId, bytes: PDF, actorKind: "system" },
        ENV,
      );
      expect(signed.id).not.toBe(sent.id);
      // Both survive: the file the client agreed to, and the countersigned copy.
      expect(await listDocuments(db, organisationId, { subjectType: "proposal", subjectId })).toHaveLength(2);
    });
  });

  it("refuses bytes that are empty, oversized or not a PDF, before writing anything", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await fixture(db);
      const store = (bytes: Uint8Array<ArrayBuffer>) => storeDocument(db, organisationId, { ...PROPOSAL, bytes }, ENV);

      await expect(store(new Uint8Array())).rejects.toThrow(DocumentRefused);
      await expect(store(new TextEncoder().encode("<html>not a pdf</html>"))).rejects.toMatchObject({ reason: "not_a_pdf" });
      await expect(store(new Uint8Array(21 * 1024 * 1024))).rejects.toMatchObject({ reason: "too_large" });
      expect(await listDocuments(db, organisationId)).toHaveLength(0);
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const { otherOrganisationId, client } = await fixture(db);
      await expect(
        storeDocument(db, otherOrganisationId, { ...PROPOSAL, clientId: client.id, bytes: PDF }, ENV),
      ).rejects.toThrow(/not found in organisation/);
    });
  });
});

describe("reading a document", () => {
  it("gives the owner their own organisation's document and nobody else's", async () => {
    await withTestDb(async (db) => {
      const { organisationId, otherOrganisationId, client } = await fixture(db);
      const document = await storeDocument(db, organisationId, { ...PROPOSAL, clientId: client.id, bytes: PDF }, ENV);

      const mine = await readDocumentForOwner(db, organisationId, { documentId: document.id }, ENV);
      expect(mine.ok).toBe(true);
      if (mine.ok) expect(Uint8Array.from(mine.bytes)).toEqual(PDF);

      expect(await readDocumentForOwner(db, otherOrganisationId, { documentId: document.id }, ENV)).toEqual({ ok: false, reason: "not_found" });
      expect(await getDocument(db, otherOrganisationId, { documentId: document.id })).toBeNull();
    });
  });

  it("gives a client their own paperwork and refuses another client's in the same organisation", async () => {
    await withTestDb(async (db) => {
      const { organisationId, client, rival } = await fixture(db);
      const document = await storeDocument(db, organisationId, { ...PROPOSAL, clientId: client.id, bytes: PDF }, ENV);

      expect((await readDocumentForClient(db, organisationId, { clientId: client.id, documentId: document.id }, ENV)).ok).toBe(true);
      expect(await readDocumentForClient(db, organisationId, { clientId: rival.id, documentId: document.id }, ENV))
        .toEqual({ ok: false, reason: "not_found" });
    });
  });

  it("refuses a lead's client-less document to every portal user", async () => {
    await withTestDb(async (db) => {
      const { organisationId, client } = await fixture(db);
      const document = await storeDocument(db, organisationId, { ...PROPOSAL, bytes: PDF }, ENV);
      expect(await readDocumentForClient(db, organisationId, { clientId: client.id, documentId: document.id }, ENV))
        .toEqual({ ok: false, reason: "not_found" });
    });
  });

  it("answers not_found when the row survives but its file is gone", async () => {
    await withTestDb(async (db) => {
      const { organisationId, client } = await fixture(db);
      const document = await storeDocument(db, organisationId, { ...PROPOSAL, clientId: client.id, bytes: PDF }, ENV);
      await rm(documentFilePath(document, ENV));
      expect(await readDocumentForOwner(db, organisationId, { documentId: document.id }, ENV)).toEqual({ ok: false, reason: "not_found" });
    });
  });

  it("names the download after the reference, not the uuid, and cannot forge the header", () => {
    expect(documentContentDisposition({ reference: "P-2026-014" })).toBe('inline; filename="P-2026-014.pdf"');
    expect(documentContentDisposition({ reference: 'a"; filename*=UTF-8\'\'setup.exe' })).toBe('inline; filename="a---filename--UTF-8--setup.exe.pdf"');
  });
});

describe("the signed link", () => {
  it("is not the public asset route, and carries an opaque token", () => {
    const url = signedDocumentUrl({ organisationId: randomUUID(), documentId: randomUUID() }, ENV);
    expect(url.startsWith(`https://os.launchflow.test${DOCUMENT_ROUTE_PATH}/`)).toBe(true);
    expect(url).not.toContain("/api/assets");
    expect(url).toMatch(/\?t=v1\.\d+\.[A-Za-z0-9_-]+$/);
  });

  it("verifies for the document and organisation it was minted for, and no other", () => {
    const organisationId = randomUUID();
    const documentId = randomUUID();
    const token = signDocumentToken({ organisationId, documentId }, ENV);

    expect(verifyDocumentToken({ organisationId, documentId, token }, ENV).ok).toBe(true);
    expect(verifyDocumentToken({ organisationId: randomUUID(), documentId, token }, ENV)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyDocumentToken({ organisationId, documentId: randomUUID(), token }, ENV)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("cannot be minted with one deployment's key and spent with another", () => {
    const organisationId = randomUUID();
    const documentId = randomUUID();
    const token = signDocumentToken({ organisationId, documentId }, OTHER_ENV);
    expect(verifyDocumentToken({ organisationId, documentId, token }, ENV)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("expires, and the recipient cannot extend it by editing the query string", () => {
    const organisationId = randomUUID();
    const documentId = randomUUID();
    const minted = new Date("2026-09-06T09:00:00Z");
    const token = signDocumentToken({ organisationId, documentId, ttlSeconds: 3600, now: minted }, ENV);

    const justBefore = new Date(minted.getTime() + 3599_000);
    expect(verifyDocumentToken({ organisationId, documentId, token, now: justBefore }, ENV).ok).toBe(true);
    const justAfter = new Date(minted.getTime() + 3601_000);
    expect(verifyDocumentToken({ organisationId, documentId, token, now: justAfter }, ENV)).toEqual({ ok: false, reason: "expired" });

    // Push the expiry out by an hour and keep the signature: it no longer covers it.
    const [version, expires, signature] = token.split(".");
    const stretched = `${version}.${Number(expires) + 3600}.${signature}`;
    expect(verifyDocumentToken({ organisationId, documentId, token: stretched, now: justAfter }, ENV))
      .toEqual({ ok: false, reason: "bad_signature" });
  });

  it("clamps the lifetime rather than trusting the caller", () => {
    const organisationId = randomUUID();
    const documentId = randomUUID();
    const now = new Date("2026-09-06T09:00:00Z");
    const expiryOf = (ttlSeconds: number) => Number(signDocumentToken({ organisationId, documentId, ttlSeconds, now }, ENV).split(".")[1]);
    const nowSeconds = Math.floor(now.getTime() / 1000);

    expect(expiryOf(365 * 24 * 3600) - nowSeconds).toBe(MAX_DOCUMENT_LINK_TTL_SECONDS);
    expect(expiryOf(-1) - nowSeconds).toBe(60);
    expect(Number(signDocumentToken({ organisationId, documentId, now }, ENV).split(".")[1]) - nowSeconds)
      .toBe(DEFAULT_DOCUMENT_LINK_TTL_SECONDS);
  });

  it("refuses junk without a stack trace", () => {
    const organisationId = randomUUID();
    const documentId = randomUUID();
    for (const token of ["", "nonsense", "v2.123.abc", "v1.notanumber.abc", "v1.123", "v1.123.a.b"]) {
      expect(verifyDocumentToken({ organisationId, documentId, token }, ENV).ok).toBe(false);
    }
    // A signature of the wrong length must not reach `timingSafeEqual`'s throw.
    expect(verifyDocumentToken({ organisationId, documentId, token: "v1.99999999999.short" }, ENV)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses to sign at all when SECRETS_ENCRYPTION_KEY is unset", () => {
    expect(() => signDocumentToken({ organisationId: randomUUID(), documentId: randomUUID() }, { APP_URL: ENV.APP_URL }))
      .toThrow(SecretsKeyError);
  });
});

describe("readSignedDocument", () => {
  it("opens the document with a valid link and no session at all", async () => {
    await withTestDb(async (db) => {
      const { organisationId, client } = await fixture(db);
      const document = await storeDocument(db, organisationId, { ...PROPOSAL, clientId: client.id, bytes: PDF }, ENV);
      const token = signDocumentToken({ organisationId, documentId: document.id }, ENV);

      const result = await readSignedDocument(db, { documentId: document.id, token }, ENV);
      expect(result.ok).toBe(true);
      if (result.ok) expect(Uint8Array.from(result.bytes)).toEqual(PDF);
    });
  });

  it("tells an expired link apart from a tampered one, and tells a tampered one nothing", async () => {
    await withTestDb(async (db) => {
      const { organisationId, client } = await fixture(db);
      const document = await storeDocument(db, organisationId, { ...PROPOSAL, clientId: client.id, bytes: PDF }, ENV);
      const minted = new Date("2026-09-06T09:00:00Z");
      const token = signDocumentToken({ organisationId, documentId: document.id, ttlSeconds: 60, now: minted }, ENV);

      expect(await readSignedDocument(db, { documentId: document.id, token, now: new Date(minted.getTime() + 120_000) }, ENV))
        .toEqual({ ok: false, reason: "expired" });
      expect(await readSignedDocument(db, { documentId: document.id, token: `${token}x`, now: minted }, ENV))
        .toEqual({ ok: false, reason: "not_found" });
      expect(await readSignedDocument(db, { documentId: randomUUID(), token, now: minted }, ENV))
        .toEqual({ ok: false, reason: "not_found" });
    });
  });

  it("will not open one organisation's document with another organisation's token", async () => {
    await withTestDb(async (db) => {
      const { organisationId, otherOrganisationId, client } = await fixture(db);
      const document = await storeDocument(db, organisationId, { ...PROPOSAL, clientId: client.id, bytes: PDF }, ENV);
      // A token minted, correctly, for the *other* tenant over this same id.
      const token = signDocumentToken({ organisationId: otherOrganisationId, documentId: document.id }, ENV);
      expect(await readSignedDocument(db, { documentId: document.id, token }, ENV)).toEqual({ ok: false, reason: "not_found" });
    });
  });
});
