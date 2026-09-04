import { redirect } from "next/navigation";
import { getClientSession } from "@/lib/portal-session";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * One landing route for both audiences: the sign-in form always pushes here,
 * and this decides. Staff membership wins if a user somehow has both, because
 * the admin portal is the more capable surface.
 */
export default async function AfterSignInPage() {
  if (await getSession()) redirect("/");
  if (await getClientSession()) redirect("/portal");
  redirect("/sign-in");
}
