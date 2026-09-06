import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { storageRoot } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";

/**
 * Where a rendered document goes and how it comes back.
 *
 * The shape follows `assets/content-assets.ts` — bytes on disk under
 * `STORAGE_DIR`, one row, audited — with one difference that is the whole
 * point of this module: **there is no read-by-id-alone path**. A content asset
 * is a photo Facebook has to fetch with no cookie, so its uuid is its access
 * control. A document is a priced proposal or an invoice, so every read goes
 * through an organisation (the owner), a client (the portal) or a signed link
 * (`document-link.ts`). Nothing here takes a bare id.
 *
 * Documents are written once and never edited. A countersigned copy of an
 * accepted proposal is a *second* document, not an update of the first, so the
 * signed file and the file the client agreed to both survive.
 */

export type DocumentRow = typeof schema.documents.$inferSelect;

export const DOCUMENT_KINDS = schema.documentKindEnum.enumValues;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The audit target type every document action is recorded under. */
export const DOCUMENT_TARGET_TYPE = "document";

/**
 * 20 MB. A proposal is a dozen pages of text; anything approaching this is a
 * runaway loop in a template, and storing it would be the second problem.
 */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** The renderer produced nothing usable, or the caller asked for too much. */
export class DocumentRefused extends Error {
  constructor(readonly reason: "empty" | "too_large" | "not_a_pdf", message: string) {
    super(message);
    this.name = "DocumentRefused";
  }
}

/** Where the file lives on disk: `STORAGE_DIR/<path>`. */
export function documentFilePath(document: Pick<DocumentRow, "path">, env: NodeJS.ProcessEnv = process.env): string {
  return join(storageRoot(env), document.path);
}

const actor = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
};

export const StoreDocumentInput = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string().trim().min(1, "A document needs a title").max(300),
  /** `P-2026-014`, `INV-2026-0087` — printed in the footer of every page. */
  reference: z.string().trim().min(1, "A document needs a reference").max(60),
  /** Null while the document belongs to a lead who is not yet a client. */
  clientId: z.string().uuid().nullish(),
  /** The table and row this document was rendered from, for the reverse lookup. */
  subjectType: z.string().trim().min(1).max(60).nullish(),
  subjectId: z.string().uuid().nullish(),
  /** The rendered bytes, straight from `renderPdf`. */
  bytes: z.instanceof(Uint8Array),
  ...actor,
});
export type StoreDocumentInput = z.input<typeof StoreDocumentInput>;

/** Every PDF starts `%PDF-`; anything else did not come from the engine. */
function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
}

/**
 * Stores a rendered document under `STORAGE_DIR/documents/<org>/<uuid>.pdf`
 * and records it.
 *
 * The bytes are checked before anything is written: empty, oversized, or not
 * a PDF is a `DocumentRefused` rather than a row pointing at a file no reader
 * will open. A digest goes in the row because an accepted proposal is
 * evidence — see `documents.sha256`.
 *
 * The file is written before the row, so a crash between the two leaves an
 * orphan file rather than a row pointing at nothing. Same trade, same reason,
 * as `createContentAsset`.
 */
export async function storeDocument(
  db: Db,
  organisationId: string,
  input: StoreDocumentInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentRow> {
  const v = StoreDocumentInput.parse(input);
  if (v.clientId) await assertClientInOrganisation(db, organisationId, v.clientId);
  if (v.bytes.byteLength === 0) throw new DocumentRefused("empty", "The document engine returned no bytes.");
  if (v.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentRefused("too_large", `Documents must be ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB or smaller.`);
  }
  if (!isPdf(v.bytes)) throw new DocumentRefused("not_a_pdf", "The document engine returned something that is not a PDF.");

  const id = randomUUID();
  const relative = join("documents", organisationId, `${id}.pdf`).replaceAll("\\", "/");
  await mkdir(join(storageRoot(env), "documents", organisationId), { recursive: true });
  await writeFile(join(storageRoot(env), relative), v.bytes);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.documents).values({
      id,
      organisationId,
      clientId: v.clientId ?? null,
      kind: v.kind,
      title: v.title,
      reference: v.reference,
      path: relative,
      mime: "application/pdf",
      sizeBytes: v.bytes.byteLength,
      sha256: createHash("sha256").update(v.bytes).digest("hex"),
      subjectType: v.subjectType ?? null,
      subjectId: v.subjectId ?? null,
      createdByUserId: v.actorKind === "user" || v.actorKind === "client" ? (v.actorId ?? null) : null,
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind,
      actorId: v.actorId,
      action: "document.stored",
      targetType: DOCUMENT_TARGET_TYPE,
      targetId: row!.id,
      after: row,
    });
    return row!;
  });
}

export const GetDocumentInput = z.object({ documentId: z.string().uuid() });
export type GetDocumentInput = z.input<typeof GetDocumentInput>;

/** One document, in this organisation. Null when it is another tenant's, or gone. */
export async function getDocument(db: Db, organisationId: string, input: GetDocumentInput): Promise<DocumentRow | null> {
  const v = GetDocumentInput.parse(input);
  const [row] = await db.select().from(schema.documents)
    .where(and(
      eq(schema.documents.id, v.documentId),
      eq(schema.documents.organisationId, organisationId),
      isNull(schema.documents.deletedAt),
    ));
  return row ?? null;
}

export const ListDocumentsInput = z.object({
  clientId: z.string().uuid().optional(),
  subjectType: z.string().trim().min(1).max(60).optional(),
  subjectId: z.string().uuid().optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type ListDocumentsInput = z.input<typeof ListDocumentsInput>;

/** A client's, or a subject's, documents — newest first. */
export async function listDocuments(db: Db, organisationId: string, input: ListDocumentsInput = {}): Promise<DocumentRow[]> {
  const v = ListDocumentsInput.parse(input);
  return db.select().from(schema.documents)
    .where(and(
      eq(schema.documents.organisationId, organisationId),
      isNull(schema.documents.deletedAt),
      v.clientId ? eq(schema.documents.clientId, v.clientId) : undefined,
      v.subjectType ? eq(schema.documents.subjectType, v.subjectType) : undefined,
      v.subjectId ? eq(schema.documents.subjectId, v.subjectId) : undefined,
      v.kind ? eq(schema.documents.kind, v.kind) : undefined,
    ))
    .orderBy(desc(schema.documents.createdAt), desc(schema.documents.id))
    .limit(v.limit);
}

/**
 * The bytes for a document row already proven to belong to the caller.
 *
 * Null when the file is missing — a restored database pointed at an empty
 * volume, say. The caller answers 404 rather than a stack trace: there is
 * nothing the reader can do about it and nothing they should learn from it.
 */
export async function readDocumentBytes(document: DocumentRow, env: NodeJS.ProcessEnv = process.env): Promise<Buffer | null> {
  try {
    return await readFile(documentFilePath(document, env));
  } catch {
    return null;
  }
}
