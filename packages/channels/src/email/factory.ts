import { z } from "zod";
import { MockEmailAdapter } from "./mock.js";
import { SmtpEmailAdapter } from "./smtp.js";
import type { EmailAdapter } from "./types.js";

const SmtpEnv = z.object({
  SMTP_HOST: z.string().min(1, "SMTP_HOST is required when EMAIL_ADAPTER=smtp"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
});

/** Mock unless EMAIL_ADAPTER is explicitly "smtp" — mock-first, per CLAUDE.md rule 4. */
export function createEmailAdapter(env: NodeJS.ProcessEnv): EmailAdapter {
  if (env.EMAIL_ADAPTER !== "smtp") return new MockEmailAdapter();
  const cfg = SmtpEnv.parse(env);
  return new SmtpEmailAdapter({
    host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, user: cfg.SMTP_USER, pass: cfg.SMTP_PASS, secure: cfg.SMTP_PORT === 465,
  });
}
