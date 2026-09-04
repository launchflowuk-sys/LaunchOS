import { z } from "zod";

/** Falls back to LaunchFlow's own domain so local dev and tests work unset. */
export const DEFAULT_SUPPORT_EMAIL_DOMAIN = "support.launchflow.co.uk";

const Domain = z
  .string()
  .min(4)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);

export function supportEmailDomain(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SUPPORT_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!raw) return DEFAULT_SUPPORT_EMAIL_DOMAIN;
  return Domain.parse(raw);
}

export function supportEmailFor(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${slug}@${supportEmailDomain(env)}`;
}
