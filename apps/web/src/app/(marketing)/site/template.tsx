import type { ReactNode } from "react";
import { MotionRoot } from "./_components/motion-root";

/**
 * Re-mounted on every navigation, unlike the layout: the short route fade
 * plays each time, and the motion runtime scans the page that has just
 * rendered for its reveals, counters and parallax.
 */
export default function MarketingTemplate({ children }: { children: ReactNode }) {
  return (
    <div className="route-enter">
      <MotionRoot />
      {children}
    </div>
  );
}
