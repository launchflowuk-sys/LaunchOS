import { z } from "zod";

/** Local to this module, matching the shape the other admin modules use. */
export type ActionResult = { status: "ok"; message?: string } | { status: "error"; message: string };

export const WordPressConnectionSchema = z.object({
  siteId: z.string().uuid(),
  username: z.string().trim().min(1, "Username is required").max(200),
  /**
   * WordPress prints application passwords as six four-character groups. The
   * spaces are kept — WordPress accepts the value with or without them, and
   * stripping them would make a pasted value look wrong when it is read back.
   */
  appPassword: z.string().trim().min(1, "Application password is required").max(500),
});
export type WordPressConnectionValues = z.input<typeof WordPressConnectionSchema>;

export const TestWordPressConnectionSchema = z.object({ siteId: z.string().uuid() });
export type TestWordPressConnectionValues = z.input<typeof TestWordPressConnectionSchema>;
