import { uploadTaskAttachment } from "@launchos/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_SCREENSHOT_BYTES, SCREENSHOT_MIMES } from "@/app/(admin)/tasks/schemas";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * A screenshot uploaded as proof of work on a task: `multipart/form-data`
 * with one `file` field.
 *
 * A route handler rather than a server action because server actions cap
 * their body at 1 MB by default and a phone screenshot can be more; the cap
 * here is `MAX_SCREENSHOT_BYTES` (8 MB), checked on the declared length before
 * the body is read and on the file after. `getSession` rather than
 * `requireAdmin` for the same reason as the push route: a `fetch` needs a 401,
 * not a redirect to the sign-in page.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/tasks/[id]/evidence">): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "sign in first" }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "not found" }, { status: 404 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  // The multipart envelope adds a few hundred bytes to the file itself.
  if (declared > MAX_SCREENSHOT_BYTES + 64 * 1024) {
    return NextResponse.json({ error: tooLarge() }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected a multipart form with a file" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "choose a screenshot first" }, { status: 400 });
  }
  if (file.size > MAX_SCREENSHOT_BYTES) return NextResponse.json({ error: tooLarge() }, { status: 413 });
  if (!SCREENSHOT_MIMES.includes(file.type)) {
    return NextResponse.json({ error: "that file is not an image (PNG, JPEG, WebP or GIF) or a PDF" }, { status: 415 });
  }

  try {
    const { attachment } = await uploadTaskAttachment(getDb(), session.organisationId, {
      taskId: id,
      name: file.name || "screenshot",
      contentType: file.type,
      contentBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
      actorKind: "user",
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true, attachment });
  } catch (error) {
    // `uploadTaskAttachment` throws "task … not found in organisation" for a
    // task that is not this tenant's — a 404 either way.
    const message = error instanceof Error ? error.message : "upload failed";
    if (message.includes("not found")) return NextResponse.json({ error: "not found" }, { status: 404 });
    console.error("[tasks/evidence] upload failed", { taskId: id, error });
    return NextResponse.json({ error: "that screenshot could not be stored" }, { status: 500 });
  }
}

function tooLarge(): string {
  return `that file is over ${Math.round(MAX_SCREENSHOT_BYTES / (1024 * 1024))} MB — crop it or export a smaller one`;
}
