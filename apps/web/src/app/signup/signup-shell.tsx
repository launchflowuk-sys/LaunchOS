import type { ReactNode } from "react";
import { BrandTile } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

/**
 * The frame every public sign-up screen sits in: the wordmark on its chip,
 * one heading, one line under it, the content, "Powered by LaunchFlow".
 * The same lockup as `/sign-in` — a buyer who has just paid and is sent to
 * the portal must see the same brand on both sides of the door.
 *
 * Wider than the sign-in card (`max-w-3xl`) because the package cards sit
 * side by side on a desktop; on a phone they stack and the frame is
 * `px-4` like everything else.
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
    <main className="flex min-h-screen flex-1 flex-col items-center bg-background px-4 py-10">
      <div className={cn("w-full", narrow ? "max-w-md" : "max-w-3xl")}>
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandTile width={148} className="rounded-xl border px-5 py-3.5 shadow-sm" priority />
          <h1 className="mt-5 text-title font-semibold text-balance">{title}</h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">{description}</p>
        </div>
        {children}
        <p className="mt-8 text-center text-meta text-muted-foreground">Powered by LaunchFlow</p>
      </div>
    </main>
  );
}
