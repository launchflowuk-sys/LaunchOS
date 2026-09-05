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

/**
 * Where the app lives, for links in email.
 *
 * The same fallback `apps/web/src/lib/env.ts` and `apps/worker/src/env.ts`
 * apply, so a developer running unset gets a link that works on their own
 * machine rather than no link at all. Both host schemas refuse an unset
 * `APP_URL` in production, which is the layer that stops a client receiving an
 * invoice that points at localhost.
 *
 * A trailing slash is normalised away here, once, because every caller
 * concatenates a path onto it: `new URL` on the result is then unambiguous and
 * no email goes out with `//portal/invoices/...` in the one link it carries.
 */
export const LOCAL_APP_URL = "http://localhost:3000";

export function appUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.APP_URL?.trim();
  try {
    return new URL(raw || LOCAL_APP_URL).toString().replace(/\/$/, "");
  } catch {
    return LOCAL_APP_URL;
  }
}

/**
 * The wordmark an email loads, absolute because a mail client has no origin of
 * its own to resolve against. Served by `apps/web/public/brand/`, so the path
 * is pinned here and in `apps/web/src/components/brand-mark.tsx` — the two must
 * name the same file, and there is no import that could keep them in step
 * without dragging the web app into `core`.
 */
export const BRAND_LOGO_PATH = "/brand/launchflow-logo@600.png";

export function brandLogoUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${appUrl(env)}${BRAND_LOGO_PATH}`;
}

/**
 * The address in the email footer: where a client writes when they have not
 * been given a case-specific one. `SUPPORT_EMAIL_DOMAIN` is what the rest of
 * this file is built on, so the default follows it rather than being a second
 * constant to forget.
 */
export function brandSupportAddress(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SUPPORT_CONTACT_EMAIL?.trim();
  if (raw) return raw;
  return supportEmailFor("hello", env);
}

/** Everything `renderBrandedEmail` needs about this deployment, in one call. */
export interface BrandEmailContext {
  logoUrl: string;
  appUrl: string;
  supportEmail: string;
}

export function brandEmailContext(env: NodeJS.ProcessEnv = process.env): BrandEmailContext {
  return { logoUrl: brandLogoUrl(env), appUrl: appUrl(env), supportEmail: brandSupportAddress(env) };
}
