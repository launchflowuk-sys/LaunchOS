import { ACCESS_REVOKED } from "@/lib/portal-session";
import { SignInForm } from "./sign-in-form";

/**
 * Why a gate sent somebody back here. Resolved on the server so the form stays
 * a plain client component: `useSearchParams` would drag the whole page behind
 * a Suspense boundary for one line of copy.
 */
const REASONS = new Map<string, string>([
  [ACCESS_REVOKED, "Your portal access has been removed. Contact us if you think that is a mistake."],
]);

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { reason } = await searchParams;
  const key = Array.isArray(reason) ? reason[0] : reason;
  // A Map, not an object literal indexed by a query parameter: `?reason=toString`
  // resolves up an object's prototype chain to a function, which is truthy, and
  // rendering a function as a React child is a 500 on the one unauthenticated
  // route the whole revoked-access flow depends on. Anything not on the list is
  // simply no notice.
  return <SignInForm notice={(key && REASONS.get(key)) || null} />;
}
