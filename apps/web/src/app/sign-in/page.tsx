import { ACCESS_REVOKED } from "@/lib/portal-session";
import { SignInForm } from "./sign-in-form";

/**
 * Why a gate sent somebody back here. Resolved on the server so the form stays
 * a plain client component: `useSearchParams` would drag the whole page behind
 * a Suspense boundary for one line of copy.
 */
const REASONS: Record<string, string> = {
  [ACCESS_REVOKED]: "Your portal access has been removed. Contact us if you think that is a mistake.",
};

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { reason } = await searchParams;
  const key = Array.isArray(reason) ? reason[0] : reason;
  return <SignInForm notice={(key && REASONS[key]) || null} />;
}
