import type { ReactNode } from "react";
import { PublicShell } from "../(marketing)/site/_components/public-shell";

/**
 * The frame every public sign-up screen sits in: the marketing site's own
 * header and footer, one heading, one line under it, the content. A buyer
 * who arrived from the pricing page sees the same site on both sides of
 * the door; the wordmark in the header is the same asset `/sign-in` uses.
 */
export function SignupShell({
  title,
  description,
  children,
  narrow = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  /** A single-column page (the done screen). */
  narrow?: boolean;
}) {
  return (
    <PublicShell title={title} description={description} narrow={narrow}>
      {children}
    </PublicShell>
  );
}
