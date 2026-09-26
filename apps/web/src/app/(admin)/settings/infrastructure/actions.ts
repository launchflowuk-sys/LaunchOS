"use server";

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BaseUrl,
  createConnection,
  importConnectionsFromEnv,
  removeConnection,
  syncInfrastructure,
  testConnection,
  updateConnection,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const PATH = "/settings/infrastructure";

/**
 * Infrastructure connections hold the keys to every server and Coolify
 * instance the business runs on, so unlike the rest of Settings (gated on the
 * `settings` permission) this area is owner-only — `requireAdminWith` has no
 * key for that, so the check is inline, same as `account/actions.ts`.
 */
async function requireOwner() {
  const session = await requireAdmin();
  if (session.role !== "owner") throw new Error("Only the owner can manage infrastructure.");
  return session;
}

export type ConnectionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved"; label: string };

export async function saveConnectionAction(_previous: ConnectionState, form: FormData): Promise<ConnectionState> {
  const session = await requireOwner();
  const id = String(form.get("id") ?? "");
  const token = String(form.get("token") ?? "").trim();
  const label = String(form.get("label") ?? "").trim();
  const baseUrl = String(form.get("baseUrl") ?? "").trim() || null;
  const serverId = String(form.get("serverId") ?? "") || null;
  try {
    if (id) {
      await updateConnection(getDb(), session.organisationId, {
        id,
        label,
        baseUrl,
        serverId,
        ...(token ? { token } : {}),
        actorId: session.userId,
      });
    } else {
      const provider = String(form.get("provider")) === "coolify" ? "coolify" : "hetzner_cloud";
      await createConnection(getDb(), session.organisationId, { provider, label, baseUrl, token, actorId: session.userId });
    }
    revalidatePath(PATH);
    return { status: "saved", label };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not save the connection." };
  }
}

/**
 * Calls the provider without saving anything. Never returns the token. The
 * URL goes through the same check as a save — the typed token is sent to it.
 */
export async function testConnectionAction(form: FormData) {
  await requireOwner();
  const provider = String(form.get("provider")) === "coolify" ? "coolify" : "hetzner_cloud";
  const rawUrl = String(form.get("baseUrl") ?? "").trim();
  const baseUrl = rawUrl ? BaseUrl.safeParse(rawUrl) : null;
  if (baseUrl && !baseUrl.success) return { ok: false as const, message: baseUrl.error.issues[0]?.message ?? "Invalid URL." };
  return testConnection({ provider, baseUrl: baseUrl?.data ?? null, token: String(form.get("token") ?? "") });
}

export async function removeConnectionAction(form: FormData): Promise<void> {
  const session = await requireOwner();
  await removeConnection(getDb(), session.organisationId, { id: String(form.get("id")), actorId: session.userId });
  revalidatePath(PATH);
}

export async function syncNowAction(): Promise<void> {
  const session = await requireOwner();
  await syncInfrastructure(getDb(), session.organisationId);
  revalidatePath(PATH);
  revalidatePath("/servers");
}

/**
 * Local only: the repo `.env` holds the tokens as a carrier. Read the file
 * itself because `.env` has two `HETZNER_API_TOKENS` lines and process.env
 * keeps only one. Absent in production, so the button simply reports nothing.
 * Returns only labels and messages — the tokens themselves never leave
 * `importConnectionsFromEnv`/`createConnection`.
 */
export async function importFromEnvAction(): Promise<{
  added: string[];
  skipped: string[];
  failed: { label: string; message: string }[];
}> {
  const session = await requireOwner();
  const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")];
  const file = candidates.find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!file) {
    return { added: [], skipped: [], failed: [{ label: ".env", message: "No .env file here — paste tokens into the form instead." }] };
  }

  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const source: Record<string, string> = {};
  const hetzner: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 1 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === "HETZNER_API_TOKENS") hetzner.push(value);
    else if (key.startsWith("COOLIFY_")) source[key] = value;
  }
  // Two `HETZNER_API_TOKENS=` lines exist in the repo `.env`; process.env
  // keeps only the last one, which is why this reads the file directly.
  // `COOLIFY_API_URL`/`COOLIFY_API_TOKEN` are skipped automatically below:
  // their values don't match the per-instance `url|token` shape.
  source.HETZNER_API_TOKENS = hetzner.join(",");

  const out = await importConnectionsFromEnv(getDb(), session.organisationId, source, session.userId);
  revalidatePath(PATH);
  return out;
}
