import { redirect } from "next/navigation";
import { ACCESS_REVOKED, getClientSession, hasRevokedPortalAccess } from "@/lib/portal-session";
import { getAuthUser, getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * One landing route for both audiences: the sign-in form always pushes here,
 * and this decides. Staff membership wins if a user somehow has both, because
 * the admin portal is the more capable surface.
 *
 * A suspended portal user still has valid credentials, so this — not
 * `requireClient` — is the route they actually take after signing in. It
 * applies the same `access-revoked` branch, otherwise the one message written
 * for them is unreachable and they retry a password that was never the problem.
 */
export default async function AfterSignInPage() {
  if (await getSession()) redirect("/");
  if (await getClientSession()) redirect("/portal");

  const u = await getAuthUser();
  if (u && (await hasRevokedPortalAccess(u.id))) redirect(`/sign-in?reason=${ACCESS_REVOKED}`);
  redirect("/sign-in");
}
