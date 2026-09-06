import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/session";
import { TwoFactorChallengeForm } from "./challenge-form";

export const dynamic = "force-dynamic";

/**
 * The challenge step of signing in.
 *
 * Deliberately unguarded: the only thing that authorises it is Better Auth's
 * signed two-factor cookie, which this page cannot read and does not need to —
 * the verify endpoints check it, and a visitor without one simply cannot get
 * past the form. The one redirect is the opposite case: somebody who already
 * holds a full session has no challenge to answer and belongs wherever
 * `/after-sign-in` sends them.
 */
export default async function TwoFactorChallengePage() {
  if (await getAuthUser()) redirect("/after-sign-in");
  return <TwoFactorChallengeForm />;
}
