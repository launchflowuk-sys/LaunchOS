import {
  documentContentDisposition,
  readDocumentForClient,
  readDocumentForOwner,
  readSignedDocument,
  DOCUMENT_TOKEN_PARAM,
  type DocumentAccessResult,
} from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getClientSession } from "@/lib/portal-session";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * A document — a proposal, a signed copy, an invoice — served privately.
 *
 * The deliberate opposite of `/api/assets/[id]`, which is public because
 * Facebook has to fetch a post's image with no cookie. Nothing about a
 * document is public, so there are three ways in and no fourth:
 *
 * 1. `?t=<token>` — the signed, expiring link that goes in an email. No
 *    session; the HMAC is the authority, and it names both the document and
 *    the organisation (`packages/core/src/documents/document-link.ts`).
 * 2. An admin session, scoped to its own organisation.
 * 3. A portal session, scoped to its organisation *and* its client.
 *
 * A signed link is tried first and, if present, is the *only* thing tried: a
 * stale link must fail for the owner in the same way it fails for a client,
 * or nobody could ever test one. Every refusal is a 404 except an expired
 * link, which is a 410 with a sentence a reader can act on — the reasoning
 * for that split is in `read-document.ts`, and the short version is that
 * distinguishing "wrong signature" from "no such document" tells a guesser
 * which uuids exist.
 */
async function resolve(request: Request, documentId: string): Promise<DocumentAccessResult> {
  const token = new URL(request.url).searchParams.get(DOCUMENT_TOKEN_PARAM);
  if (token) return readSignedDocument(getDb(), { documentId, token });

  const admin = await getSession();
  if (admin) return readDocumentForOwner(getDb(), admin.organisationId, { documentId });

  const client = await getClientSession();
  if (client) {
    return readDocumentForClient(getDb(), client.organisationId, { clientId: client.clientId, documentId });
  }
  return { ok: false, reason: "not_found" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: RouteContext<"/api/documents/[id]">): Promise<Response> {
  const { id } = await params;
  // A malformed id is a 404 before it reaches Postgres, where it would raise
  // 22P02 and surface as a 500. Same rule as `uuidOr404` in the page routes.
  if (!UUID.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = await resolve(request, id);
  if (!result.ok) {
    return result.reason === "expired"
      ? NextResponse.json({ error: "This link has expired. Ask us for a fresh one." }, { status: 410 })
      : NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(result.bytes), {
    headers: {
      "content-type": result.document.mime,
      "content-length": String(result.bytes.byteLength),
      "content-disposition": documentContentDisposition(result.document),
      // Never cached by a proxy and never left in a shared cache: this is one
      // named person's priced proposal, not an image.
      "cache-control": "private, no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}
