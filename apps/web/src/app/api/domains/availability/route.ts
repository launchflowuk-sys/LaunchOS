import { createIntegrations } from "@launchos/integrations";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Is this name free, and what would it cost.
 *
 * Admin-only and deliberately not on the client portal: the figure it returns
 * is what *we* pay, and a supplier's price quoted straight to a client is a
 * price with no margin on it. This answers "can I promise them that name"
 * while somebody is writing a proposal — it is not a shop front.
 */
const Query = z.object({ name: z.string().trim().min(3).max(253).toLowerCase() });

export async function GET(request: Request) {
  await requireAdmin();

  const parsed = Query.safeParse({ name: new URL(request.url).searchParams.get("name") ?? "" });
  if (!parsed.success) return NextResponse.json({ error: "give a domain name" }, { status: 400 });
  if (!parsed.data.name.includes(".")) {
    return NextResponse.json({ error: "include the ending, like .co.uk" }, { status: 400 });
  }

  const registrar = createIntegrations(process.env).registrar;
  if (!registrar) return NextResponse.json({ error: "No registrar is configured." }, { status: 503 });

  try {
    return NextResponse.json(await registrar.checkAvailability(parsed.data.name));
  } catch (error) {
    // A supplier that cannot be reached is not "the name is taken" — reporting
    // it as taken would have somebody give up on a name nobody ever checked.
    console.error("[domains] availability check failed", { name: parsed.data.name, error });
    return NextResponse.json({ error: "The registrar could not be reached." }, { status: 502 });
  }
}
