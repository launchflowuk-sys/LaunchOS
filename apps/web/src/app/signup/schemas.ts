import { z } from "zod";

/** A failure is a sentence on the form; success is a redirect, so it never returns. */
export type SignupActionResult = { status: "error"; message: string };

const Blank = (max: number, message: string) => z.string().trim().min(1, message).max(max);

export const SignupSchema = z.object({
  packageSlug: z.string().trim().min(1, "Choose a package").max(60),
  name: Blank(120, "Enter your name"),
  business: Blank(200, "Enter your business name"),
  email: z.string().trim().min(1, "Enter your email address").max(320).email("Enter a full email address"),
  phone: z
    .string()
    .trim()
    .max(40, "Keep the phone number under 40 characters")
    .optional()
    .transform((v) => (v ? v : undefined)),
});
export type SignupValues = z.input<typeof SignupSchema>;

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
