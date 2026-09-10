"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { recordScreenView } from "@/app/(admin)/activity-actions";

/**
 * Reports the screen a member is on, once per arrival.
 *
 * A ref guards against React running the effect twice in development and
 * against a re-render counting a second visit to a screen nobody left. It
 * renders nothing and never blocks: if the write fails the person is not told,
 * because a tally is not worth an error message.
 */
export function ActivityRecorder() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    void recordScreenView(pathname);
  }, [pathname]);

  return null;
}
